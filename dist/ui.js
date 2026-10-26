// Bouton micro du composeur (slot `composer.before_send`).
//
// Cliquer ouvre le micro : une onde suit la voix, un compteur dit depuis
// combien de temps on parle. Recliquer arrête ; Échap annule. Le clip part
// vers `ui_transcribe_clip` (outil réservé au panneau, invisible du modèle),
// puis le texte s'écrit dans le champ de saisie, lettre après lettre.
//
// Rendu dans le document, avec les classes de l'application : pas de racine
// fantôme, le thème de l'hôte s'applique.
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
      this.flux = null;
      this.enregistreur = null;
      this.morceaux = [];
      this.annule = false;
      this.debut = 0;
      this.anim = 0;
      this.contexteAudio = null;
      this.analyseur = null;
      this.surTouche = this.surTouche.bind(this);
    }

    connectedCallback() {
      this.style.display = "inline-flex";
      this.style.alignItems = "center";
      this.render();
    }

    disconnectedCallback() {
      this.annule = true;
      this.liberer();
    }

    render() {
      cancelAnimationFrame(this.anim);
      if (this.etat === "ecoute") return this.renderEcoute();
      if (this.etat === "transcription") return this.renderTranscription();
      this.innerHTML =
        '<button type="button" class="locaryn-chip-btn" title="Dicter un message" aria-label="Dicter un message">' +
        MIC +
        "</button>";
      var self = this;
      this.querySelector("button").addEventListener("click", function () {
        self.demarrer();
      });
    }

    renderEcoute() {
      var barres = "";
      for (var i = 0; i < BARRES; i++) {
        barres +=
          '<span data-barre style="display:block;width:3px;height:4px;border-radius:2px;' +
          'background:var(--accent);transition:height 80ms linear"></span>';
      }
      this.innerHTML =
        '<span class="locaryn-chip-btn locaryn-chip-on" role="group" aria-label="Dictée en cours" ' +
        'style="gap:8px;padding-right:4px">' +
        '<button type="button" data-annuler class="locaryn-btn-ghost" title="Annuler (Échap)" aria-label="Annuler la dictée" ' +
        'style="display:inline-grid;place-items:center;min-width:24px;min-height:24px;padding:0;border:0;background:none;color:inherit;cursor:pointer">' +
        CROIX +
        "</button>" +
        '<span aria-hidden="true" style="display:inline-flex;align-items:center;gap:2px;height:18px">' +
        barres +
        "</span>" +
        '<span data-temps style="font-family:var(--font-mono);font-size:11px;min-width:30px">0:00</span>' +
        '<button type="button" data-arreter title="Terminer la dictée" aria-label="Terminer la dictée" ' +
        'style="display:inline-grid;place-items:center;min-width:24px;min-height:24px;border-radius:50%;border:0;' +
        'background:var(--accent);color:var(--on-accent);cursor:pointer">' +
        STOP +
        "</button></span>";
      var self = this;
      this.querySelector("[data-arreter]").addEventListener("click", function () {
        self.arreter(false);
      });
      this.querySelector("[data-annuler]").addEventListener("click", function () {
        self.arreter(true);
      });
      this.querySelector("[data-arreter]").focus();
      this.animerOnde();
    }

    renderTranscription() {
      var points = "";
      for (var i = 0; i < 3; i++) {
        points +=
          '<span data-point style="display:block;width:5px;height:5px;border-radius:50%;background:currentColor;opacity:.35"></span>';
      }
      this.innerHTML =
        '<span class="locaryn-chip-btn" role="status" aria-live="polite" style="gap:8px;cursor:default">' +
        '<span aria-hidden="true" style="display:inline-flex;gap:3px;align-items:center">' +
        points +
        "</span>" +
        '<span data-libelle>Transcription…</span></span>';
      this.animerPoints();
    }

    // L'onde suit le niveau réel du micro, réparti sur les barres.
    animerOnde() {
      var barres = this.querySelectorAll("[data-barre]");
      var temps = this.querySelector("[data-temps]");
      var donnees = this.analyseur ? new Uint8Array(this.analyseur.frequencyBinCount) : null;
      var self = this;
      var tick = function () {
        if (self.etat !== "ecoute") return;
        if (temps) temps.textContent = duree(Date.now() - self.debut);
        if (donnees && self.analyseur) {
          self.analyseur.getByteFrequencyData(donnees);
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

    animerPoints() {
      var points = this.querySelectorAll("[data-point]");
      var libelle = this.querySelector("[data-libelle]");
      var depart = Date.now();
      var self = this;
      var tick = function () {
        if (self.etat !== "transcription") return;
        var t = (Date.now() - depart) / 1000;
        for (var i = 0; i < points.length; i++) {
          var phase = Math.sin(t * 6 - i * 0.9);
          points[i].style.opacity = String(0.35 + Math.max(0, phase) * 0.65);
          if (!mouvementReduit()) points[i].style.transform = "translateY(" + (-Math.max(0, phase) * 3) + "px)";
        }
        if (libelle && t > 6) libelle.textContent = "Transcription… " + Math.floor(t) + " s";
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
      preparer().catch(function () {});
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
      this.flux = flux;
      this.morceaux = [];
      this.annule = false;
      var type = typeAudio();
      this.enregistreur = type ? new MediaRecorder(flux, { mimeType: type }) : new MediaRecorder(flux);
      var self = this;
      this.enregistreur.ondataavailable = function (e) {
        if (e.data && e.data.size) self.morceaux.push(e.data);
      };
      this.enregistreur.onstop = function () {
        self.apresEcoute();
      };
      this.brancherAnalyseur(flux);
      this.enregistreur.start(250);
      this.debut = Date.now();
      this.etat = "ecoute";
      document.addEventListener("keydown", this.surTouche, true);
      this.render();
    }

    brancherAnalyseur(flux) {
      try {
        var Ctx = window.AudioContext || window.webkitAudioContext;
        this.contexteAudio = new Ctx();
        this.analyseur = this.contexteAudio.createAnalyser();
        this.analyseur.fftSize = 64;
        this.analyseur.smoothingTimeConstant = 0.7;
        this.contexteAudio.createMediaStreamSource(flux).connect(this.analyseur);
      } catch (e) {
        // Sans analyseur, l'onde reste à plat ; l'enregistrement continue.
        console.warn("[dictaphone] analyseur audio indisponible :", e);
        this.analyseur = null;
      }
    }

    arreter(annuler) {
      this.annule = !!annuler;
      document.removeEventListener("keydown", this.surTouche, true);
      if (this.enregistreur && this.enregistreur.state !== "inactive") this.enregistreur.stop();
      else this.apresEcoute();
    }

    liberer() {
      if (this.flux) {
        this.flux.getTracks().forEach(function (t) {
          t.stop();
        });
      }
      if (this.contexteAudio) {
        this.contexteAudio.close().catch(function (e) {
          console.warn("[dictaphone] fermeture audio :", e);
        });
      }
      this.flux = null;
      this.contexteAudio = null;
      this.analyseur = null;
      this.enregistreur = null;
    }

    apresEcoute() {
      var type = (this.enregistreur && this.enregistreur.mimeType) || typeAudio() || "audio/webm";
      var morceaux = this.morceaux;
      this.liberer();
      if (this.annule || !morceaux.length) {
        this.etat = "repos";
        this.render();
        return;
      }
      this.etat = "transcription";
      this.render();
      var self = this;
      var blob = new Blob(morceaux, { type: type });
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
