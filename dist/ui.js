// Bouton micro du composeur (slot `composer.before_send`).
//
// Cliquer ouvre le micro : une onde suit la voix, un compteur dit depuis
// combien de temps on parle. Le carré termine ; Échap ou la croix annule. Le
// clip part vers `ui_transcribe_clip` (outil réservé au panneau, invisible du
// modèle), puis le texte s'écrit dans le champ de saisie, lettre après lettre.
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
      // La préparation part tout de suite : on parle pendant qu'elle se fait.
      preparer().catch(function (e) {
        console.warn("[dictaphone] préparation :", e);
      });
      var self = this;
      navigator.mediaDevices
        .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
        .then(function (flux) {
          self.ouvrir(flux);
        })
        .catch(function (e) {
          var refus = e && (e.name === "NotAllowedError" || e.name === "SecurityError");
          toast(refus ? "L'accès au micro a été refusé." : "Micro indisponible : " + (e && e.message), "error");
        });
    }

    ouvrir(flux) {
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
