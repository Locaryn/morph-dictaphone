# morph-dictaphone

Dicter ses messages et transcrire ses enregistrements, sur la machine, par
whisper. Rien n'est envoyé ailleurs.

## Le bouton micro

Un micro apparaît à côté du bouton Envoyer.

- **Cliquer** ouvre le micro : une onde suit la voix, un compteur dit depuis
  combien de temps on parle.
- **Recliquer** (le carré) termine ; **Échap** ou la croix annule.
- Le texte s'écrit dans le champ de saisie, à la suite de ce qui y est déjà.
  Rien n'est envoyé tant qu'on n'a pas appuyé sur Envoyer.

La première dictée installe la reconnaissance vocale (`faster-whisper`, une
fois par machine) pendant qu'on parle, puis télécharge le modèle `small`
(environ 460 Mo, dans le cache désigné par Locaryn). Les suivantes prennent
quelques secondes.

Sans carte graphique libre, la transcription passe sur le processeur : plus
lente, mais elle aboutit.

## La dictée en direct

Avec le modèle **Nemotron 3.5 ASR** (NVIDIA, `nvidia/nemotron-3.5-asr-streaming-0.6b`,
licence OpenMDW-1.1), le texte s'affiche au-dessus du champ **pendant qu'on
parle** :

- le texte provisoire, atténué, se complète à chaque bloc de 160 ms ;
- à chaque pause (700 ms de silence), la phrase s'écrit dans le champ ;
- un instant plus tard, sa repasse complète la remplace (ponctuation finale,
  majuscule, contexte entier).

Le modèle s'installe depuis le catalogue des modèles, catégorie
**Transcription** (choisir la variante `model.safetensors`, 2,6 Go). Il n'est
jamais téléchargé en silence : sans lui, le bouton reste en dictée classique et
le dit une fois. Les paquets Python qui lui manquent (`transformers` ≥ 5.13,
`librosa`) s'installent seuls au premier passage.

Mesures sur une RTX 4050 6 Go, machine au repos :

| | |
|---|---|
| Mémoire vidéo | 1,3 Go (fp16), 1,5 Go au compteur de la carte |
| Calcul par bloc de 320 ms | 100 à 200 ms |
| Mot affiché après avoir été dit | 0,3 à 0,6 s |
| Repasse d'une phrase de 4 à 6 s | 0,5 à 0,9 s |
| Premier lancement (Python, torch, modèle) | 30 à 40 s ; la voix est gardée et rattrapée |

Le processus reste chargé deux minutes après la dernière dictée, puis rend sa
mémoire. À son lancement, il prend la carte s'il y reste 1,8 Go libres ; sinon
il passe sur le processeur, qui suit à peine le temps réel (0,4 à 1 s par
bloc). Un modèle de conversation qui génère en même temps ralentit nettement
la transcription : la carte est partagée.

## Pour le modèle

L'outil `transcribe_audio` transcrit un fichier présent sur la machine (WAV,
MP3, M4A, OGG, FLAC) et rend le texte, la langue reconnue et les passages
horodatés.

Les outils `ui_dictation_status`, `ui_dictation_prepare`,
`ui_transcribe_clip` et `ui_live_*` (`status`, `prepare`, `start`, `audio`,
`end`, `poll`, `drain`) servent le bouton : l'hôte les cache au modèle.

## Prérequis

Python 3.10 ou plus récent. Locaryn emploie l'environnement Python qu'il gère.

## Réglages

- `model` : `tiny`, `base`, `small` (défaut), `medium`, `large-v3`.
- `device` : `cuda` ou `cpu` ; vide, la carte si elle est là.
