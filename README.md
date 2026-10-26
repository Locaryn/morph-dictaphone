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

## Pour le modèle

L'outil `transcribe_audio` transcrit un fichier présent sur la machine (WAV,
MP3, M4A, OGG, FLAC) et rend le texte, la langue reconnue et les passages
horodatés.

Les outils `ui_dictation_status`, `ui_dictation_prepare` et
`ui_transcribe_clip` servent le bouton : l'hôte les cache au modèle.

## Prérequis

Python 3.10 ou plus récent. Locaryn emploie l'environnement Python qu'il gère.

## Réglages

- `model` : `tiny`, `base`, `small` (défaut), `medium`, `large-v3`.
- `device` : `cuda` ou `cpu` ; vide, la carte si elle est là.
