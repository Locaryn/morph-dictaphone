// Bouton micro du composeur (slot `composer.before_send`).
//
// Cliquer ouvre le micro : une onde suit la voix, un compteur dit depuis
// combien de temps on parle. Le carré termine ; Échap ou la croix annule. Le
// clip part vers `ui_transcribe_clip` (outil réservé au panneau, invisible du
// modèle), puis le texte s'écrit dans le champ de saisie, lettre après lettre.
//
// Avec le modèle de transcription en direct installé (catalogue du morph), le
// texte s'affiche pendant qu'on parle, au-dessus du composeur : provisoire en
// atténué, définitif à chaque silence.
//
// Rendu dans le document, avec les classes de l'application : pas de racine
// fantôme, le thème de l'hôte s'applique. Aucun attribut `style` : la
// politique de sécurité de l'hôte les bloque. Les styles passent par
// `element.style`, qu'elle autorise.
(function () {
  "use strict";

  var TAG = "locaryn-dictaphone-btn";
  var BARRES = 14;
  var MIC =
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/>' +
    '<path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/></svg>';
  var STOP =
    '<svg width="11" height="11" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="3" fill="currentColor"/></svg>';
  var CROIX =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
    'stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  function api() {
    return window.locaryn || window.LocarynPluginAPI || null;
  }

  function mouvementReduit() {
    return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function toast(message, type) {
    var a = api();
    if (a && a.ui && a.ui.showToast) a.ui.showToast(message, type || "info");
    else console.warn("[dictaphone]", message);
  }

  // Un élément, ses attributs, ses styles (par `element.style`) et ses enfants.
  function el(tag, attrs, styles, enfants) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === "class") n.className = attrs[k];
      else n.setAttribute(k, attrs[k]);
    });
    if (styles) Object.assign(n.style, styles);
    (enfants || []).forEach(function (c) {
      n.append(c);
    });
    return n;
  }

  // Une icône SVG : ses attributs de dessin ne sont pas des styles.
  function icone(svg) {
    var s = el("span", { "aria-hidden": "true" }, { display: "inline-flex" });
    s.innerHTML = svg;
    return s;
  }

  var ROND = {
    display: "inline-grid",
    placeItems: "center",
    minWidth: "24px",
    minHeight: "24px",
    padding: "0",
    border: "0",
    borderRadius: "50%",
    cursor: "pointer",
  };

  // La réponse d'un outil arrive en texte JSON, parfois enveloppée dans le
  // `content` MCP.
  function lireReponse(brut) {
    var v = brut;
    if (typeof v === "string") {
      try {
        v = JSON.parse(v);
      } catch (e) {
        return { text: v };
      }
    }
    if (v && Array.isArray(v.content) && v.content[0] && typeof v.content[0].text === "string") {
      return lireReponse(v.content[0].text);
    }
    return v || {};
  }

  function appeler(outil, args) {
    var a = api();
    if (!a || !a.tools || !a.tools.invoke) {
      return Promise.reject(new Error("Le pont de Locaryn est indisponible."));
    }
    return a.tools.invoke(outil, args || {}).then(lireReponse);
  }

  function enDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () {
        resolve(String(r.result));
      };
      r.onerror = function () {
        reject(r.error || new Error("Lecture de l'enregistrement impossible."));
      };
      r.readAsDataURL(blob);
    });
  }

  function typeAudio() {
    var candidats = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4", "audio/webm"];
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return "";
    for (var i = 0; i < candidats.length; i++) {
      if (MediaRecorder.isTypeSupported(candidats[i])) return candidats[i];
    }
    return "";
  }

  function duree(ms) {
    var s = Math.floor(ms / 1000);
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }

  // ── Préparation : une seule fois par session, en parallèle de l'écoute ──
  var preparation = null;
  function preparer() {
    if (preparation) return preparation;
    preparation = appeler("ui_dictation_status")
      .then(function (etat) {
        if (etat.ready) return etat;
        if (etat.python === false) throw new Error(etat.problem || "Python introuvable.");
        toast("Première dictée : installation de la reconnaissance vocale…", "info");
        return appeler("ui_dictation_prepare");
      })
      .catch(function (e) {
        preparation = null;
        throw e;
      });
    return preparation;
  }

  // ── Transcription en direct ──────────────────────────────────────────
  //
  // Le micro est lu en PCM 16 kHz par blocs de 160 ms et part vers
  // `ui_live_audio`, qui rend le texte provisoire du segment en cours. Un
  // silence clôt le segment : `ui_live_end` rend son texte définitif, qui
  // remplace le provisoire et s'écrit dans le champ. Le modèle vient du
  // catalogue du morph ; sans lui, la dictée classique reste en service.

  var TAUX = 16000;
  var BLOC_ENVOI = 2560; // 160 ms
  var PREROLL = 5120; // 320 ms gardés avant la parole
  var SILENCE_FIN_MS = 700;
  // Fin de dictée : au-delà, on rend la main même sans la dernière repasse.
  var FINALISATION_MAX_MS = 90000;

  var direct = null; // null : inconnu ; sinon la réponse de ui_live_status
  var sondeDirect = null;
  var conseilDonne = false;
  // Le modèle met une vingtaine de secondes à se charger : on le charge dès
  // que la main approche du bouton, et il reste prêt dix minutes.
  var dernierPrechauffage = 0;
  function prechauffer() {
    if (!direct || !direct.ready || Date.now() - dernierPrechauffage < 60000) return;
    dernierPrechauffage = Date.now();
    appeler("ui_live_warm").catch(function (e) {
      dernierPrechauffage = 0;
      console.warn("[dictaphone] préchauffage du direct :", e);
    });
  }
  function approche() {
    sonderDirect().then(prechauffer);
  }
  function sonderDirect() {
    if (sondeDirect) return sondeDirect;
    sondeDirect = appeler("ui_live_status")
      .then(function (etat) {
        direct = etat;
        // Paquets absents : ils s'installent en arrière-plan ; la dictée
        // reste classique jusque-là.
        if (etat.model_installed && !etat.packages) {
          appeler("ui_live_prepare")
            .then(function () {
              direct = Object.assign({}, etat, { ready: true, packages: true });
              prechauffer();
            })
            .catch(function (e) {
              console.warn("[dictaphone] installation du direct :", e);
            });
        }
        return etat;
      })
      .catch(function (e) {
        console.warn("[dictaphone] transcription en direct indisponible :", e);
        direct = { ready: false };
        return direct;
      });
    return sondeDirect;
  }

  function versInt16(f32) {
    var out = new Int16Array(f32.length);
    for (var i = 0; i < f32.length; i++) {
      var v = Math.max(-1, Math.min(1, f32[i]));
      out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    return out;
  }

  function enBase64(i16) {
    var octets = new Uint8Array(i16.buffer, i16.byteOffset, i16.byteLength);
    var s = "";
    for (var i = 0; i < octets.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, octets.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }

  // Ramener le flux du micro à 16 kHz : la moyenne de chaque fenêtre suffit
  // à la voix et évite le repliement le plus grossier.
  function reechantillonner(entree, taux) {
    if (taux === TAUX) return entree;
    var r = taux / TAUX;
    var n = Math.floor(entree.length / r);
    var out = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var a = Math.floor(i * r);
      var b = Math.min(entree.length, Math.floor((i + 1) * r)) || a + 1;
      var s = 0;
      for (var j = a; j < b; j++) s += entree[j];
      out[i] = s / Math.max(1, b - a);
    }
    return out;
  }

  function concat(a, b) {
    var out = new Float32Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  function enWav(f32) {
    var pcm = versInt16(f32);
    var buf = new ArrayBuffer(44 + pcm.byteLength);
    var v = new DataView(buf);
    var ecrire = function (o, s) {
      for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
    };
    ecrire(0, "RIFF");
    v.setUint32(4, 36 + pcm.byteLength, true);
    ecrire(8, "WAVEfmt ");
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, TAUX, true);
    v.setUint32(28, TAUX * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    ecrire(36, "data");
    v.setUint32(40, pcm.byteLength, true);
    new Int16Array(buf, 44).set(pcm);
    return new Blob([buf], { type: "audio/wav" });
  }

  // Le texte de la dictée s'écrit dans le champ, grisé, tant qu'elle n'est pas
  // finie (`chat.setDraft` de l'application) : le définitif, puis le
  // provisoire du segment en cours ; un état (chargement…) tant que rien n'est
  // dit. `fermer` rend le champ normal, avec le texte posé par `setText`.
  // Une application sans `setDraft` reçoit le texte définitif en clair.
  function Sous_titre(avant) {
    this.debut = avant && !/\s$/.test(avant) ? avant + " " : avant || "";
    this.etat = "";
    this.definitif = "";
    this.provisoire = "";
    this.ferme = false;
  }
  Sous_titre.prototype.poser = function () {
    var a = api();
    if (this.ferme || !a || !a.chat || typeof a.chat.setDraft !== "function") return;
    var dit = [this.definitif, this.provisoire].filter(Boolean).join(" ");
    a.chat.setDraft(this.debut + (dit || this.etat));
  };
  Sous_titre.prototype.statut = function (texte) {
    this.etat = texte || "";
    this.poser();
  };
  Sous_titre.prototype.montrer = function (definitif, provisoire) {
    this.definitif = definitif || "";
    this.provisoire = provisoire || "";
    this.poser();
  };
  Sous_titre.prototype.fermer = function () {
    if (this.ferme) return;
    this.ferme = true;
    var a = api();
    if (a && a.chat && typeof a.chat.setDraft === "function") a.chat.setDraft(null);
  };

  // Une dictée en direct : capture, détection de la parole, envois en file.
  function Direct(ecoute, rappels) {
    this.ecoute = ecoute;
    // { provisoire(texte), definitif(id, texte), corriger(id, texte), echec(message) }
    this.rappels = rappels;
    this.enAttente = 0; // segments clos dont la repasse n'est pas revenue
    this.minuteur = 0;
    this.tout = new Float32Array(0); // gardé pour le repli sur la dictée classique
    this.attente = new Float32Array(0);
    this.preroll = new Float32Array(0);
    this.parole = false;
    this.silenceMs = 0;
    this.plancher = 0.004;
    this.file = [];
    this.occupe = false;
    this.pret = false;
    this.echoue = false;
    this.fini = null;
  }

  // Le module de capture : il recopie chaque tampon du micro vers la page.
  // Un worklet tourne hors du fil principal ; quand la machine est chargée,
  // ses messages attendent au lieu de se perdre.
  var WORKLET =
    "registerProcessor('locaryn-dictaphone-capture', class extends AudioWorkletProcessor {" +
    "process(entrees) { var c = entrees[0] && entrees[0][0]; if (c) this.port.postMessage(c.slice(0)); return true; } });";

  Direct.prototype.brancher = function () {
    var self = this;
    var ctx = this.ecoute.contexte;
    var source = ctx.createMediaStreamSource(this.ecoute.flux);
    var muet = ctx.createGain();
    muet.gain.value = 0;
    muet.connect(ctx.destination);
    var recevoir = function (f32) {
      self.recevoir(reechantillonner(f32, ctx.sampleRate));
    };
    var parScript = function () {
      // Repli : l'ancien nœud, sur le fil principal.
      self.noeud = ctx.createScriptProcessor(2048, 1, 1);
      self.noeud.onaudioprocess = function (e) {
        recevoir(new Float32Array(e.inputBuffer.getChannelData(0)));
      };
      source.connect(self.noeud);
      self.noeud.connect(muet);
    };
    if (!ctx.audioWorklet || !window.AudioWorkletNode) return Promise.resolve(parScript());
    var url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
    return ctx.audioWorklet
      .addModule(url)
      .then(function () {
        self.noeud = new AudioWorkletNode(ctx, "locaryn-dictaphone-capture");
        self.noeud.port.onmessage = function (e) {
          recevoir(e.data);
        };
        source.connect(self.noeud);
        self.noeud.connect(muet);
      })
      .catch(function (e) {
        console.warn("[dictaphone] worklet refusé, capture sur le fil principal :", e);
        parScript();
      })
      .finally(function () {
        URL.revokeObjectURL(url);
      });
  };

  Direct.prototype.demarrer = function (langue) {
    var self = this;
    this.brancher();
    return appeler("ui_live_start", { language: langue })
      .then(function (r) {
        self.pret = true;
        self.moteur = r.engine || {};
        self.pomper();
        return r;
      })
      .catch(function (e) {
        self.echouer(e);
        throw e;
      });
  };

  // Un bloc de micro : niveau, parole ou silence, mise en file.
  Direct.prototype.recevoir = function (morceau) {
    if (this.arrete) return;
    this.tout = concat(this.tout, morceau);
    if (this.echoue) return;
    var s = 0;
    for (var i = 0; i < morceau.length; i++) s += morceau[i] * morceau[i];
    var rms = Math.sqrt(s / Math.max(1, morceau.length));
    var dureeMs = (morceau.length / TAUX) * 1000;
    // Le plancher de bruit suit lentement le niveau le plus bas entendu.
    this.plancher = rms < this.plancher ? rms : this.plancher * 1.002;
    var parle = rms > Math.max(0.012, this.plancher * 3);
    if (!this.parole) {
      this.preroll = concat(this.preroll, morceau).slice(-PREROLL);
      if (!parle) return;
      this.parole = true;
      this.silenceMs = 0;
      this.attente = this.preroll;
      this.preroll = new Float32Array(0);
      return this.envoyerSiPlein();
    }
    this.attente = concat(this.attente, morceau);
    this.silenceMs = parle ? 0 : this.silenceMs + dureeMs;
    if (this.silenceMs >= SILENCE_FIN_MS) {
      this.clore();
      return;
    }
    this.envoyerSiPlein();
  };

  Direct.prototype.envoyerSiPlein = function () {
    if (this.attente.length < BLOC_ENVOI) return;
    this.file.push({ op: "audio", pcm: this.attente });
    this.attente = new Float32Array(0);
    this.pomper();
  };

  // Fin de segment : ce qui reste, puis la demande du texte définitif.
  Direct.prototype.clore = function () {
    if (this.attente.length) this.file.push({ op: "audio", pcm: this.attente });
    this.attente = new Float32Array(0);
    if (this.parole) this.file.push({ op: "end" });
    this.parole = false;
    this.silenceMs = 0;
    this.pomper();
  };

  function texteDe(ecoute) {
    return ecoute.textes
      .map(function (x) {
        return x.texte;
      })
      .join(" ");
  }

  var OUTIL = { audio: "ui_live_audio", end: "ui_live_end", poll: "ui_live_poll", drain: "ui_live_drain" };

  // Un envoi à la fois ; les blocs audio en attente partent ensemble. File
  // vide : en fin de dictée, la dernière repasse ; sinon, si des segments
  // attendent la leur, un relevé un peu plus tard.
  Direct.prototype.pomper = function () {
    if (this.occupe || !this.pret || this.echoue) return;
    var item = this.file.shift();
    if (!item && this.fini && !this.vide) {
      this.vide = true;
      item = { op: "drain" };
    }
    if (!item) {
      if (this.fini) this.fini();
      else if (this.enAttente > 0) this.releverPlusTard();
      return;
    }
    while (item.op === "audio" && this.file.length && this.file[0].op === "audio") {
      item = { op: "audio", pcm: concat(item.pcm, this.file.shift().pcm) };
    }
    this.occupe = true;
    var self = this;
    var args = item.op === "audio" ? { pcm: enBase64(versInt16(item.pcm)) } : {};
    appeler(OUTIL[item.op], args)
      .then(function (r) {
        self.occupe = false;
        self.repondre(item.op, r);
        self.pomper();
      })
      .catch(function (e) {
        self.occupe = false;
        self.echouer(e);
      });
  };

  Direct.prototype.repondre = function (op, r) {
    var self = this;
    (r.corrections || []).forEach(function (c) {
      self.enAttente = Math.max(0, self.enAttente - 1);
      self.rappels.corriger(c.id, String(c.text || "").trim());
    });
    if (op === "end") {
      var texte = String(r.final || "").trim();
      if (texte) this.enAttente += 1;
      this.rappels.definitif(r.id, texte);
    } else if (op === "audio") {
      this.rappels.provisoire(String(r.partial || ""));
      // Un segment sans silence ne grandit pas sans fin.
      if (r.full && this.parole) this.clore();
    }
  };

  Direct.prototype.releverPlusTard = function () {
    if (this.minuteur) return;
    var self = this;
    this.minuteur = setTimeout(function () {
      self.minuteur = 0;
      if (self.arrete || self.echoue || self.file.length || self.enAttente <= 0) return;
      self.file.push({ op: "poll" });
      self.pomper();
    }, 500);
  };

  Direct.prototype.echouer = function (e) {
    if (this.echoue) return;
    this.echoue = true;
    this.file = [];
    this.rappels.echec(e && e.message ? e.message : String(e));
    if (this.fini) this.fini();
  };

  // Arrêter la capture, vider la file ; la promesse se résout quand la
  // dernière repasse est arrivée.
  Direct.prototype.terminer = function () {
    var self = this;
    this.arrete = true;
    clearTimeout(this.minuteur);
    if (this.noeud) {
      if (this.noeud.port) this.noeud.port.onmessage = null;
      else this.noeud.onaudioprocess = null;
      this.noeud.disconnect();
    }
    return new Promise(function (resolve) {
      self.fini = resolve;
      if (self.echoue) return resolve();
      // Si le modèle charge encore, la file partira quand il sera prêt.
      if (self.parole) self.clore();
      else self.pomper();
    });
  };

  class LocarynDictaphoneBtn extends HTMLElement {
    constructor() {
      super();
      this.etat = "repos"; // repos | ecoute | transcription
      // L'écoute en cours : son flux, son enregistreur, ses morceaux. Une
      // écoute précédente qui finirait en retard ne touche pas à celle-ci.
      this.ecoute = null;
      this.anim = 0;
      this.surTouche = this.surTouche.bind(this);
    }

    connectedCallback() {
      this.style.display = "inline-flex";
      this.style.alignItems = "center";
      // Savoir si le direct est prêt coûte un lancement de Python : on le
      // demande quand la main approche du bouton, pas au chargement.
      this.addEventListener("pointerenter", approche);
      this.addEventListener("focusin", approche);
      this.render();
    }

    disconnectedCallback() {
      cancelAnimationFrame(this.anim);
      document.removeEventListener("keydown", this.surTouche, true);
      if (this.ecoute) this.fermer(this.ecoute, true);
    }

    render() {
      cancelAnimationFrame(this.anim);
      this.replaceChildren();
      if (this.etat === "ecoute") return this.renderEcoute();
      if (this.etat === "transcription") return this.renderTranscription();
      var bouton = el(
        "button",
        { type: "button", class: "locaryn-chip-btn", title: "Dicter un message", "aria-label": "Dicter un message" },
        null,
        [icone(MIC)],
      );
      var self = this;
      bouton.addEventListener("click", function () {
        self.demarrer();
      });
      this.append(bouton);
    }

    renderEcoute() {
      var self = this;
      var annuler = el(
        "button",
        { type: "button", class: "locaryn-btn-ghost", title: "Annuler (Échap)", "aria-label": "Annuler la dictée" },
        Object.assign({}, ROND, { background: "none", color: "inherit" }),
        [icone(CROIX)],
      );
      annuler.addEventListener("click", function () {
        self.arreter(true);
      });
      var barres = [];
      for (var i = 0; i < BARRES; i++) {
        barres.push(
          el("span", { "data-barre": "" }, {
            display: "block",
            width: "3px",
            height: "4px",
            borderRadius: "2px",
            background: "var(--accent)",
            transition: "height 80ms linear",
          }),
        );
      }
      var onde = el("span", { "aria-hidden": "true" }, { display: "inline-flex", alignItems: "center", gap: "2px", height: "18px" }, barres);
      var temps = el("span", { "data-temps": "" }, { fontFamily: "var(--font-mono)", fontSize: "11px", minWidth: "30px" }, ["0:00"]);
      var arreter = el(
        "button",
        { type: "button", title: "Terminer la dictée", "aria-label": "Terminer la dictée", "data-arreter": "" },
        Object.assign({}, ROND, { background: "var(--accent)", color: "var(--on-accent)" }),
        [icone(STOP)],
      );
      arreter.addEventListener("click", function () {
        self.arreter(false);
      });
      var pastille = el(
        "span",
        { class: "locaryn-chip-btn locaryn-chip-on", role: "group", "aria-label": "Dictée en cours" },
        { gap: "8px", paddingRight: "4px" },
        [annuler, onde, temps, arreter],
      );
      this.append(pastille);
      arreter.focus();
      this.animerOnde(barres, temps);
    }

    renderTranscription() {
      var points = [];
      for (var i = 0; i < 3; i++) {
        points.push(
          el("span", null, { display: "block", width: "5px", height: "5px", borderRadius: "50%", background: "currentColor", opacity: "0.35" }),
        );
      }
      var libelle = el("span", null, null, ["Transcription…"]);
      var statut = el(
        "span",
        { class: "locaryn-chip-btn", role: "status", "aria-live": "polite" },
        { gap: "8px", cursor: "default" },
        [el("span", { "aria-hidden": "true" }, { display: "inline-flex", gap: "3px", alignItems: "center" }, points), libelle],
      );
      this.append(statut);
      this.animerPoints(points, libelle);
    }

    // L'onde suit le niveau réel du micro, réparti sur les barres.
    animerOnde(barres, temps) {
      var ecoute = this.ecoute;
      var analyseur = ecoute && ecoute.analyseur;
      var donnees = analyseur ? new Uint8Array(analyseur.frequencyBinCount) : null;
      var self = this;
      var tick = function () {
        if (self.etat !== "ecoute" || self.ecoute !== ecoute) return;
        temps.textContent = duree(Date.now() - ecoute.debut);
        if (donnees) {
          analyseur.getByteFrequencyData(donnees);
          var pas = Math.floor(donnees.length / BARRES) || 1;
          for (var i = 0; i < barres.length; i++) {
            var v = donnees[i * pas] / 255;
            barres[i].style.height = Math.max(4, Math.round(4 + v * 14)) + "px";
          }
        }
        self.anim = requestAnimationFrame(tick);
      };
      tick();
    }

    animerPoints(points, libelle) {
      var depart = Date.now();
      var self = this;
      var tick = function () {
        if (self.etat !== "transcription") return;
        var t = (Date.now() - depart) / 1000;
        for (var i = 0; i < points.length; i++) {
          var phase = Math.max(0, Math.sin(t * 6 - i * 0.9));
          points[i].style.opacity = String(0.35 + phase * 0.65);
          if (!mouvementReduit()) points[i].style.transform = "translateY(" + -phase * 3 + "px)";
        }
        if (t > 6) libelle.textContent = "Transcription… " + Math.floor(t) + " s";
        self.anim = requestAnimationFrame(tick);
      };
      tick();
    }

    surTouche(e) {
      if (e.key === "Escape" && this.etat === "ecoute") {
        e.preventDefault();
        this.arreter(true);
      }
    }

    demarrer() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
        toast("Ce navigateur ne permet pas d'enregistrer le micro.", "error");
        return;
      }
      var self = this;
      // Le mode (direct ou classique) se décide avant d'ouvrir le micro ; la
      // réponse est rapide et gardée pour la session.
      Promise.all([
        navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }),
        // Une réponse très lente ne retient pas le micro indéfiniment : passé
        // 6 s, la dictée part en classique.
        Promise.race([
          sonderDirect().then(function (etat) {
            prechauffer();
            return etat;
          }),
          new Promise(function (r) {
            setTimeout(r, 6000);
          }),
        ]),
      ])
        .then(function (r) {
          self.ouvrir(r[0]);
        })
        .catch(function (e) {
          var refus = e && (e.name === "NotAllowedError" || e.name === "SecurityError");
          toast(refus ? "L'accès au micro a été refusé." : "Micro indisponible : " + (e && e.message), "error");
        });
    }

    ouvrir(flux) {
      if (direct && direct.ready) return this.ouvrirDirect(flux);
      if (direct && direct.model && !direct.model_installed && !conseilDonne) {
        conseilDonne = true;
        toast(
          "Pour voir le texte pendant que vous parlez, installez « Nemotron 3.5 ASR » depuis le catalogue des modèles (Transcription).",
          "info",
        );
      }
      return this.ouvrirClassique(flux);
    }

    // ── Mode en direct ──
    ouvrirDirect(flux) {
      var ecoute = { flux: flux, direct: true, annule: false, debut: Date.now(), contexte: null, analyseur: null };
      this.brancherAnalyseur(ecoute);
      if (!ecoute.contexte) return this.ouvrirClassique(flux);
      var a = api();
      var self = this;
      ecoute.avant = a && a.chat ? a.chat.getText() : "";
      ecoute.textes = [];
      ecoute.sousTitre = new Sous_titre(ecoute.avant);
      ecoute.sousTitre.statut("Préparation de la dictée en direct… parlez, rien ne sera perdu");
      ecoute.moteur = new Direct(ecoute, {
        provisoire: function (t) {
          if (self.ecoute !== ecoute) return;
          ecoute.sousTitre.montrer(texteDe(ecoute), t);
        },
        definitif: function (id, t) {
          if (self.ecoute !== ecoute && !ecoute.finalisation) return;
          if (t) ecoute.textes.push({ id: id, texte: t });
          self.majDirect(ecoute);
        },
        // La repasse complète d'un segment remplace son texte.
        corriger: function (id, t) {
          ecoute.textes.forEach(function (x) {
            if (x.id === id && t) x.texte = t;
          });
          self.majDirect(ecoute);
        },
        echec: function (message) {
          console.warn("[dictaphone] direct :", message);
          ecoute.sousTitre.statut("Direct interrompu : la dictée sera transcrite à la fin.");
        },
      });
      ecoute.moteur
        .demarrer(navigator.language || "auto")
        .then(function () {
          var gpu = ecoute.moteur.moteur && ecoute.moteur.moteur.device === "cpu" ? " (processeur)" : "";
          ecoute.sousTitre.statut(gpu ? "À l'écoute" + gpu + "…" : "À l'écoute…");
        })
        .catch(function (e) {
          console.warn("[dictaphone] démarrage du direct :", e);
        });
      this.ecoute = ecoute;
      this.etat = "ecoute";
      document.addEventListener("keydown", this.surTouche, true);
      this.render();
    }

    majDirect(ecoute) {
      ecoute.sousTitre.montrer(texteDe(ecoute), "");
      if (!ecoute.annule) this.ecrireDirect(ecoute);
    }

    ecrireDirect(ecoute) {
      var a = api();
      if (!a || !a.chat) return;
      var avant = ecoute.avant;
      var debut = avant && !/\s$/.test(avant) ? avant + " " : avant;
      a.chat.setText(debut + texteDe(ecoute));
    }

    fermerDirect(ecoute, annuler) {
      var self = this;
      ecoute.annule = ecoute.annule || !!annuler;
      ecoute.finalisation = true;
      this.ecoute = null;
      if (ecoute.annule) {
        var a = api();
        if (a && a.chat) a.chat.setText(ecoute.avant);
        ecoute.sousTitre.fermer();
      } else {
        this.etat = "transcription";
        this.render();
      }
      ecoute.sousTitre.statut(ecoute.annule ? "" : "Finalisation…");
      // Un moteur qui ne répond plus ne garde pas le bandeau à l'écran : passé
      // ce délai, le texte déjà dicté reste tel quel dans le champ.
      var delai = new Promise(function (r) {
        setTimeout(function () {
          r("delai");
        }, FINALISATION_MAX_MS);
      });
      Promise.race([ecoute.moteur.terminer(), delai]).then(function (issue) {
        self.liberer(ecoute);
        if (issue === "delai") {
          ecoute.moteur.echoue = true;
          ecoute.moteur.file = [];
          ecoute.sousTitre.fermer();
          self.etat = "repos";
          self.render();
          if (!ecoute.annule) toast("La transcription en direct ne répond plus ; le texte déjà dicté est conservé.", "warning");
          return;
        }
        if (!ecoute.annule && ecoute.moteur.echoue) return self.reprendreClassique(ecoute);
        ecoute.sousTitre.fermer();
        self.etat = "repos";
        self.render();
        if (!ecoute.annule && !ecoute.textes.length) toast("Rien n'a été compris. Réessayez plus près du micro.", "warning");
      });
    }

    // Le direct a lâché : tout ce qui a été dit repart en une fois par
    // whisper, comme une dictée classique.
    reprendreClassique(ecoute) {
      var self = this;
      ecoute.sousTitre.fermer();
      var wav = enWav(ecoute.moteur.tout);
      preparer()
        .then(function () {
          return enDataUrl(wav);
        })
        .then(function (url) {
          return appeler("ui_transcribe_clip", { audio_base64: url, mime: "audio/wav" });
        })
        .then(function (res) {
          self.etat = "repos";
          self.render();
          var a = api();
          if (a && a.chat) a.chat.setText(ecoute.avant);
          var texte = String(res.text || "").trim();
          if (!texte) toast("Rien n'a été compris. Réessayez plus près du micro.", "warning");
          else self.ecrire(texte);
        })
        .catch(function (e) {
          self.etat = "repos";
          self.render();
          toast("Dictée impossible : " + (e && e.message ? e.message : String(e)), "error");
        });
    }

    // ── Mode classique : un clip, transcrit à la fin ──
    ouvrirClassique(flux) {
      // La préparation part tout de suite : on parle pendant qu'elle se fait.
      preparer().catch(function (e) {
        console.warn("[dictaphone] préparation :", e);
      });
      var type = typeAudio();
      var ecoute = {
        flux: flux,
        type: type || "audio/webm",
        morceaux: [],
        annule: false,
        debut: Date.now(),
        enregistreur: type ? new MediaRecorder(flux, { mimeType: type }) : new MediaRecorder(flux),
        contexte: null,
        analyseur: null,
      };
      var self = this;
      ecoute.enregistreur.ondataavailable = function (e) {
        if (e.data && e.data.size) ecoute.morceaux.push(e.data);
      };
      ecoute.enregistreur.onstop = function () {
        self.apresEcoute(ecoute);
      };
      this.brancherAnalyseur(ecoute);
      // Sans découpage : un seul morceau à l'arrêt, en-tête compris.
      ecoute.enregistreur.start();
      this.ecoute = ecoute;
      this.etat = "ecoute";
      document.addEventListener("keydown", this.surTouche, true);
      this.render();
    }

    brancherAnalyseur(ecoute) {
      try {
        var Ctx = window.AudioContext || window.webkitAudioContext;
        ecoute.contexte = new Ctx();
        ecoute.analyseur = ecoute.contexte.createAnalyser();
        ecoute.analyseur.fftSize = 64;
        ecoute.analyseur.smoothingTimeConstant = 0.7;
        ecoute.contexte.createMediaStreamSource(ecoute.flux).connect(ecoute.analyseur);
      } catch (e) {
        // Sans analyseur, l'onde reste à plat ; l'enregistrement continue.
        console.warn("[dictaphone] analyseur audio indisponible :", e);
        ecoute.analyseur = null;
      }
    }

    arreter(annuler) {
      var ecoute = this.ecoute;
      if (!ecoute) return;
      document.removeEventListener("keydown", this.surTouche, true);
      this.fermer(ecoute, annuler);
    }

    // Arrêter l'enregistreur ; `onstop` rend la suite à `apresEcoute`.
    fermer(ecoute, annuler) {
      if (ecoute.direct) return this.fermerDirect(ecoute, annuler);
      ecoute.annule = ecoute.annule || !!annuler;
      if (ecoute.enregistreur.state !== "inactive") ecoute.enregistreur.stop();
      else this.apresEcoute(ecoute);
    }

    liberer(ecoute) {
      ecoute.flux.getTracks().forEach(function (t) {
        t.stop();
      });
      if (ecoute.contexte) {
        ecoute.contexte.close().catch(function (e) {
          console.warn("[dictaphone] fermeture audio :", e);
        });
      }
    }

    apresEcoute(ecoute) {
      this.liberer(ecoute);
      if (this.ecoute !== ecoute) return;
      this.ecoute = null;
      if (ecoute.annule || !ecoute.morceaux.length) {
        this.etat = "repos";
        this.render();
        return;
      }
      this.etat = "transcription";
      this.render();
      var self = this;
      var type = ecoute.enregistreur.mimeType || ecoute.type;
      var blob = new Blob(ecoute.morceaux, { type: type });
      preparer()
        .then(function () {
          return enDataUrl(blob);
        })
        .then(function (url) {
          return appeler("ui_transcribe_clip", { audio_base64: url, mime: type });
        })
        .then(function (res) {
          self.etat = "repos";
          self.render();
          var texte = String(res.text || "").trim();
          if (!texte) toast("Rien n'a été compris. Réessayez plus près du micro.", "warning");
          else self.ecrire(texte);
        })
        .catch(function (e) {
          self.etat = "repos";
          self.render();
          toast("Dictée impossible : " + (e && e.message ? e.message : String(e)), "error");
        });
    }

    // Le texte s'écrit dans le champ, à la suite de ce qui y est déjà.
    ecrire(texte) {
      var a = api();
      if (!a || !a.chat) return;
      var avant = a.chat.getText();
      var debut = avant && !/\s$/.test(avant) ? avant + " " : avant;
      if (mouvementReduit()) {
        a.chat.setText(debut + texte);
        return;
      }
      var i = 0;
      var pas = Math.max(1, Math.ceil(texte.length / 60));
      var tick = function () {
        i = Math.min(texte.length, i + pas);
        a.chat.setText(debut + texte.slice(0, i));
        if (i < texte.length) setTimeout(tick, 16);
      };
      tick();
    }
  }

  if (!customElements.get(TAG)) {
    customElements.define(TAG, LocarynDictaphoneBtn);
  }
})();
