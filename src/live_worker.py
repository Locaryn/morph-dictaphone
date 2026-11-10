# Transcription en direct : un processus qui reste chargé pendant la dictée.
#
# Protocole : une requête JSON par ligne sur l'entrée standard, une réponse
# JSON par ligne sur la sortie, préfixée par MARQUE (les bibliothèques
# écrivent aussi sur la sortie ; seules ces lignes comptent).
#
#   {"op": "load", "model": "<dossier ou dépôt>", "vram_min_mb": 1800}
#   {"op": "start", "language": "fr-FR"}
#   {"op": "audio", "pcm": "<base64 int16 LE, 16 kHz mono>"}  -> partial
#   {"op": "end"}                                              -> final, id
#   {"op": "drain"}           fermer le flux, faire les repasses en attente
#   {"op": "poll"}            relever les corrections prêtes
#   Toute réponse peut porter "corrections": [{"id", "text"}] : la repasse
#   complète d'un segment clos, qui remplace son texte.
#   {"op": "quit"}
#
# Le modèle tourne en flux (encodeur à cache, RNN-T) pendant toute la
# dictée et rend un texte provisoire à chaque bloc. Un segment = une phrase
# entre deux silences : à sa borne, son texte est rendu aussitôt ; le
# segment entier repasse ensuite d'un coup, entre deux requêtes, et ce
# texte-là — contexte complet, ponctuation finale — le remplace.
import base64
import json
import queue
import sys
import threading
import time

MARQUE = "@@LIVE@@"
TAUX = 16000
# Un segment ne s'allonge pas sans fin : au-delà, il est clos même sans
# silence, pour borner la mémoire et le temps du passage final.
SEGMENT_MAX_S = 30.0
# Ce que `generate` (transformers, Parakeet et Nemotron ASR) pose sur le
# modèle le temps d'un appel.
ETAT_GENERATE = (
    "_streaming",
    "_stream_exhausted",
    "_streaming_num_lookahead_tokens",
    "_prompt_ids",
    "_encoder_finished",
    "_symbols_at_frame",
    "_step_durations",
    "get_audio_features",
)
# Au-delà, le flux se referme à la borne suivante.
FLUX_MAX_S = 300.0


MOTEUR = None


def repondre(obj):
    # Chaque réponse emporte les repasses terminées depuis la précédente.
    if MOTEUR is not None and isinstance(obj, dict) and "error" not in obj:
        pris = MOTEUR.relever()
        if pris:
            obj["corrections"] = pris
    sys.stdout.write(MARQUE + json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def journal(msg):
    sys.stderr.write("[live] " + msg + "\n")
    sys.stderr.flush()


try:
    import numpy as np
    import torch
    from transformers import AutoModelForRNNT, AutoProcessor
    from transformers.generation.streamers import BaseStreamer
except Exception as e:  # noqa: BLE001 - rendu tel quel à l'appelant
    repondre({"error": "Bibliothèques absentes : " + str(e)})
    sys.exit(1)


class Jetons(BaseStreamer):
    """Les jetons émis par le décodeur, au fil de l'eau."""

    def __init__(self):
        self.ids = []
        self.verrou = threading.Lock()

    def put(self, value):
        v = value.reshape(-1).tolist() if hasattr(value, "reshape") else list(value)
        with self.verrou:
            self.ids.extend(int(x) for x in v)

    def end(self):
        pass

    def copie(self):
        with self.verrou:
            return list(self.ids)


class Moteur:
    def __init__(self):
        self.processor = None
        self.model = None
        self.device = "cpu"
        self.dtype = torch.float32
        self.segment = None
        self.langue = "auto"
        # Les segments clos attendent leur repasse ici. Elle se fait dans les
        # silences : deux passages simultanés du modèle se corrompent.
        self.a_repasser = []
        self.corrections = []
        self.numero = 0
        self.borne_ids = 0
        self.borne_audio = 0

    # ── Chargement ──────────────────────────────────────────────────────
    def charger(self, source, vram_min_mb):
        t0 = time.time()
        self.processor = AutoProcessor.from_pretrained(source)
        self.device = self.choisir_device(vram_min_mb)
        # 320 ms d'anticipation sur la carte ; le processeur suit mieux le
        # temps réel avec des blocs plus longs (560 ms).
        self.processor.set_num_lookahead_tokens(3 if self.device == "cuda" else 6)
        self.dtype = torch.float16 if self.device == "cuda" else torch.float32
        self.model = AutoModelForRNNT.from_pretrained(source, dtype=self.dtype).to(self.device)
        self.model.eval()
        self.prechauffer()
        vram = 0
        if self.device == "cuda":
            vram = int(torch.cuda.max_memory_reserved() / 1048576)
        return {
            "ok": True,
            "device": self.device,
            "vram_mb": vram,
            "load_s": round(time.time() - t0, 2),
            "latency_ms": int(self.processor.streaming_latency_ms),
        }

    def prechauffer(self):
        # Le premier passage compile les noyaux : sans lui, le premier bloc de
        # la première dictée attendait près de 4 s.
        bruit = (np.random.default_rng(0).standard_normal(TAUX * 2) * 0.01).astype(np.float32)
        self.langue = "auto"
        seg = Segment(self)
        seg.ajouter(bruit)
        seg.clore()
        self.passage_entier(bruit, "auto")

    @staticmethod
    def choisir_device(vram_min_mb):
        # La carte porte souvent le modèle de conversation : on ne la prend
        # que si elle a la place, sinon le processeur suffit à 0,6 B.
        if not torch.cuda.is_available():
            return "cpu"
        libre, _total = torch.cuda.mem_get_info()
        if libre / 1048576 < vram_min_mb:
            journal(f"carte : {int(libre / 1048576)} Mo libres < {vram_min_mb} Mo, processeur")
            return "cpu"
        return "cuda"

    def langue_valide(self, langue):
        connues = getattr(self.processor, "prompt_dictionary", None) or {}
        if langue and langue in connues:
            return langue
        court = (langue or "").split("-")[0]
        if court in connues:
            return court
        return "auto"

    # ── Flux et segments ────────────────────────────────────────────────
    #
    # Un seul flux reste ouvert pendant toute la dictée : le relancer à
    # chaque phrase coûtait près d'une seconde, au moment où l'on se remet à
    # parler. Un segment n'est qu'une borne dans ce flux — ses jetons et son
    # audio depuis la borne précédente.
    def commencer(self, langue):
        self.abandonner()
        self.langue = self.langue_valide(langue)
        self.ouvrir_flux()
        return {"ok": True, "language": self.langue}

    def ouvrir_flux(self):
        # Le flux démarre sur un premier bloc de silence : son lancement
        # (près d'une seconde) se fait pendant qu'on ouvre la bouche, pas
        # sur les premiers mots.
        self.segment = Segment(self)
        self.segment.ajouter(np.zeros(self.processor.num_samples_first_audio_chunk, dtype=np.float32))
        self.borne_ids = len(self.segment.jetons.copie())
        self.borne_audio = len(self.segment.audio)

    def recevoir(self, pcm_b64):
        if self.segment is None:
            self.ouvrir_flux()
        brut = base64.b64decode(pcm_b64)
        echantillons = np.frombuffer(brut, dtype="<i2").astype(np.float32) / 32768.0
        t0 = time.time()
        self.segment.ajouter(echantillons)
        duree = (len(self.segment.audio) - self.borne_audio) / TAUX
        return {
            "partial": self.segment.texte(self.borne_ids),
            "compute_ms": int((time.time() - t0) * 1000),
            "audio_s": round(duree, 2),
            "full": duree >= SEGMENT_MAX_S,
        }

    def finir(self):
        """Poser une borne : le texte du segment tout de suite, sa repasse
        complète (ponctuation finale, contexte entier) plus tard, dans
        `corrections`."""
        flux = self.segment
        if flux is None:
            return {"final": ""}
        texte = flux.texte(self.borne_ids)
        audio = flux.audio[self.borne_audio:]
        self.borne_ids = len(flux.jetons.copie())
        self.borne_audio = len(flux.audio)
        self.numero += 1
        if len(audio) >= 0.3 * TAUX and texte:
            self.a_repasser.append((self.numero, audio, self.langue))
        # Un flux très long garde tout son audio : on le referme au-delà de
        # quelques minutes, le suivant repart de zéro.
        if flux.duree() >= FLUX_MAX_S:
            self.abandonner()
        return {"final": texte, "id": self.numero, "audio_s": round(len(audio) / TAUX, 2)}

    def libre(self):
        """Entre deux requêtes, le flux attend son bloc suivant : le modèle
        est libre pour une repasse."""
        return True

    def repasser_un(self):
        numero, audio, langue = self.a_repasser.pop(0)
        t0 = time.time()
        try:
            texte = self.passage_entier(audio, langue)
            if texte:
                self.corrections.append({"id": numero, "text": texte, "ms": int((time.time() - t0) * 1000)})
        except Exception as e:  # noqa: BLE001 - le texte du flux reste
            journal("repasse : " + str(e))

    def relever(self):
        pris, self.corrections = self.corrections, []
        return pris

    def vider(self):
        """Fin de dictée : fermer le flux, faire les repasses en attente."""
        self.abandonner()
        while self.a_repasser:
            self.repasser_un()
        return {"ok": True, "pending": 0}

    def sonder(self):
        return {"ok": True, "pending": len(self.a_repasser)}

    def abandonner(self):
        if self.segment is not None:
            self.segment.clore()
            self.segment = None
            self.borne_ids = 0
            self.borne_audio = 0

    @torch.inference_mode()
    def passage_entier(self, audio, langue="auto"):
        p = self.processor
        entree = p(audio, sampling_rate=TAUX, language=langue, return_tensors="pt")
        entree = entree.to(self.device, dtype=self.dtype)
        # `generate` range l'état du flux en cours sur le modèle lui-même ;
        # une repasse l'écraserait, et le flux suspendu repartirait faux.
        etat = {k: self.model.__dict__[k] for k in ETAT_GENERATE if k in self.model.__dict__}
        try:
            sortie = self.model.generate(**entree, return_dict_in_generate=True)
        finally:
            for k in ETAT_GENERATE:
                self.model.__dict__.pop(k, None)
            self.model.__dict__.update(etat)
        texte = p.decode(sortie.sequences, skip_special_tokens=True)
        if isinstance(texte, list):
            texte = texte[0] if texte else ""
        return net(texte)


def net(texte):
    """Une seule espace entre les mots : le modèle en double après un point."""
    return " ".join(str(texte).split())


class Segment:
    """Un flux de transcription, de la première parole au silence."""

    def __init__(self, moteur):
        self.m = moteur
        self.audio = np.zeros(0, dtype=np.float32)
        self.jetons = Jetons()
        self.file = queue.Queue()
        self.demandes = 0
        self.demande = threading.Condition()
        self.fil = None
        self.idx_mel = 0
        self.debut = 0
        self.erreur = None

    def duree(self):
        return len(self.audio) / TAUX

    def ajouter(self, echantillons):
        self.audio = np.concatenate([self.audio, echantillons])
        p = self.m.processor
        if self.fil is None:
            if len(self.audio) < p.num_samples_first_audio_chunk:
                return
            self.lancer()
        envoyes = 0
        while True:
            fin = self.debut + p.num_samples_per_audio_chunk
            if fin > len(self.audio):
                break
            self.pousser(self.audio[self.debut:fin])
            envoyes += 1
        if envoyes:
            self.attendre(envoyes)

    def pousser(self, morceau):
        p = self.m.processor
        fe = p.feature_extractor
        entree = p(
            morceau,
            sampling_rate=TAUX,
            is_streaming=True,
            is_first_audio_chunk=False,
            language=self.m.langue,
            return_tensors="pt",
        ).to(self.m.device, dtype=self.m.dtype)
        self.file.put(entree.input_features)
        self.idx_mel += p.num_mel_frames_per_audio_chunk
        self.debut = self.idx_mel * fe.hop_length - fe.n_fft // 2

    def lancer(self):
        p = self.m.processor
        fe = p.feature_extractor
        premier = p(
            self.audio[: p.num_samples_first_audio_chunk],
            sampling_rate=TAUX,
            is_streaming=True,
            is_first_audio_chunk=True,
            language=self.m.langue,
            return_tensors="pt",
        ).to(self.m.device, dtype=self.m.dtype)
        self.idx_mel = p.num_mel_frames_first_audio_chunk
        self.debut = self.idx_mel * fe.hop_length - fe.n_fft // 2
        tete = premier.input_features[:, : p.num_mel_frames_first_audio_chunk, :]
        seg = self

        def caracteristiques():
            yield tete
            while True:
                with seg.demande:
                    seg.demandes += 1
                    seg.demande.notify_all()
                item = seg.file.get()
                if item is None:
                    return
                yield item

        kwargs = dict(premier)
        kwargs["input_features"] = caracteristiques()
        kwargs["streamer"] = self.jetons

        def travail():
            try:
                with torch.inference_mode():
                    self.m.model.generate(**kwargs)
            except Exception as e:  # noqa: BLE001 - remonté au segment
                seg.erreur = str(e)
                journal("flux : " + str(e))
            finally:
                with seg.demande:
                    seg.demandes += 1_000_000
                    seg.demande.notify_all()

        self.fil = threading.Thread(target=travail, daemon=True)
        self.fil.start()
        # Le premier bloc est traité quand le générateur redemande.
        self.attendre(0)

    def attendre(self, envoyes):
        # Le générateur redemande un bloc quand le précédent est décodé.
        cible = self.demandes + envoyes if envoyes else 1
        with self.demande:
            self.demande.wait_for(lambda: self.demandes >= cible, timeout=5.0)

    def texte(self, depuis=0):
        ids = self.jetons.copie()[depuis:]
        if not ids:
            return ""
        # La ponctuation de fin du segment précédent arrive parfois après
        # sa borne : elle ne commence pas le suivant.
        return net(self.m.processor.tokenizer.decode(ids, skip_special_tokens=True)).lstrip(".,;:!?… ")

    def clore(self):
        if self.fil is None:
            return ""
        p = self.m.processor
        # Le dernier bloc incomplet, complété de silence, puis un bloc de
        # silence pour vider l'anticipation de l'encodeur.
        reste = self.audio[self.debut:]
        bloc = p.num_samples_per_audio_chunk
        for _ in range(2):
            morceau = np.zeros(bloc, dtype=np.float32)
            n = min(len(reste), bloc)
            morceau[:n] = reste[:n]
            reste = reste[n:]
            self.pousser(morceau)
        self.file.put(None)
        self.fil.join(timeout=10.0)
        return self.texte()


def lire_entree(file):
    for ligne in sys.stdin:
        file.put(ligne)
    file.put(None)


def main():
    global MOTEUR
    moteur = Moteur()
    MOTEUR = moteur
    entree = queue.Queue()
    threading.Thread(target=lire_entree, args=(entree,), daemon=True).start()
    while True:
        try:
            ligne = entree.get(timeout=0.05)
        except queue.Empty:
            # Un silence : le moment de repasser un segment clos.
            if moteur.a_repasser and moteur.libre():
                moteur.repasser_un()
            continue
        if ligne is None:
            return
        if traiter(moteur, ligne.strip()) == "quit":
            return


def traiter(moteur, ligne):
    if not ligne:
        return None
    try:
        req = json.loads(ligne)
        op = req.get("op")
        if op == "load":
            repondre(moteur.charger(req["model"], int(req.get("vram_min_mb", 1800))))
        elif op == "start":
            repondre(moteur.commencer(req.get("language") or "auto"))
        elif op == "audio":
            repondre(moteur.recevoir(req.get("pcm") or ""))
        elif op == "end":
            repondre(moteur.finir())
        elif op == "drain":
            repondre(moteur.vider())
        elif op == "ping":
            repondre({"ok": True})
        elif op == "poll":
            repondre(moteur.sonder())
        elif op == "quit":
            moteur.abandonner()
            repondre({"ok": True})
            return "quit"
        else:
            repondre({"error": "opération inconnue : " + str(op)})
    except Exception as e:  # noqa: BLE001 - rendu à l'appelant
        repondre({"error": str(e)})
    return None


if __name__ == "__main__":
    main()
