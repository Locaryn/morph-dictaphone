//! La dictée depuis le bouton micro du composeur.
//!
//! Le panneau enregistre la voix dans le navigateur de l'application et
//! l'envoie ici en base64 : un clip de dictée dure quelques secondes, et il
//! ne passe jamais par la conversation — les outils `ui_` ne sont visibles que
//! du panneau. Le clip est écrit dans un fichier temporaire, transcrit, puis
//! effacé.

use crate::{find_python, run_python_args, transcribe_audio, TranscribeRequest, TranscribeResult};
use base64::Engine as _;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;

/// Les versions épinglées qu'installe la première dictée. PyAV 17 et plus a
/// retiré `metadata_errors`, que faster-whisper 1.2.1 passe à `av.open` :
/// sans l'épingle, la transcription échoue sur un `TypeError`.
pub const PAQUETS: [&str; 2] = ["faster-whisper==1.2.1", "av==16.1.0"];

/// Prêt seulement si l'import passe **et** que PyAV accepte ce qu'on lui
/// demande — un autre paquet du même Python peut l'avoir mis à jour.
const SONDE: &str = "import faster_whisper, av\nassert int(av.__version__.split('.')[0]) <= 16";

/// Une dictée de plusieurs minutes en Opus tient en quelques mégaoctets ;
/// au-delà, c'est un enregistrement, et `transcribe_audio` le prend par son
/// chemin.
const CLIP_MAX_BYTES: usize = 25 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
pub struct ClipRequest {
    /// L'audio, en base64 — avec ou sans préfixe `data:…;base64,`.
    pub audio_base64: String,
    /// Le type que le navigateur a produit (`audio/webm;codecs=opus`…).
    #[serde(default)]
    pub mime: String,
    #[serde(default)]
    pub language: Option<String>,
}

/// La dictée est-elle prête : Python trouvé, `faster-whisper` importable ?
pub async fn status() -> Value {
    let Some(python) = find_python() else {
        return json!({
            "ready": false,
            "python": false,
            "problem": "Python introuvable. Installez Python 3.10 ou plus récent."
        });
    };
    let pret = whisper_importable(&python).await;
    json!({ "ready": pret, "python": true, "needs_install": !pret })
}

/// Installer `faster-whisper` dans le Python que la dictée emploie.
///
/// Une seule fois par machine : demander à la personne d'ouvrir un terminal
/// pour un `pip install` rendait le bouton inutilisable.
pub async fn prepare() -> Result<Value, String> {
    let python = find_python()
        .ok_or_else(|| "Python introuvable. Installez Python 3.10 ou plus récent.".to_string())?;
    if whisper_importable(&python).await {
        return Ok(json!({ "ready": true, "installed": false }));
    }
    let args = [
        "-m",
        "pip",
        "install",
        "--disable-pip-version-check",
        PAQUETS[0],
        PAQUETS[1],
    ];
    run_python_args(&python, &args)
        .await
        .map_err(|e| format!("L'installation de faster-whisper a échoué : {e}"))?;
    Ok(json!({ "ready": true, "installed": true }))
}

async fn whisper_importable(python: &str) -> bool {
    run_python_args(python, &["-c", SONDE]).await.is_ok()
}

/// Transcrire un clip venu du micro.
pub async fn transcribe_clip(req: ClipRequest) -> Result<TranscribeResult, String> {
    let octets = decode(&req.audio_base64)?;
    if octets.is_empty() {
        return Err("L'enregistrement est vide : le micro n'a rien capté.".into());
    }
    if octets.len() > CLIP_MAX_BYTES {
        return Err(
            "Clip trop long pour une dictée : enregistrez un fichier et transcrivez-le.".into(),
        );
    }
    let dossier = clip_dir();
    std::fs::create_dir_all(&dossier).map_err(|e| {
        format!(
            "Le dossier {} n'a pas pu être créé : {e}",
            dossier.display()
        )
    })?;
    let chemin = dossier.join(nom_de_clip(&req.mime));
    std::fs::write(&chemin, &octets).map_err(|e| format!("Le clip n'a pas pu être écrit : {e}"))?;

    let resultat = transcribe_audio(TranscribeRequest {
        file_path: chemin.to_string_lossy().into_owned(),
        language: req.language,
        model: None,
    })
    .await;
    if let Err(e) = std::fs::remove_file(&chemin) {
        eprintln!(
            "dictaphone : le clip {} n'a pas pu être effacé : {e}",
            chemin.display()
        );
    }
    resultat
}

/// Le contenu base64, débarrassé d'un éventuel préfixe d'URL de données.
fn decode(brut: &str) -> Result<Vec<u8>, String> {
    let donnees = brut
        .split_once(";base64,")
        .map_or(brut, |(_, apres)| apres)
        .trim();
    base64::engine::general_purpose::STANDARD
        .decode(donnees)
        .map_err(|e| format!("Audio illisible (base64) : {e}"))
}

/// L'extension que ffmpeg attend pour ce type.
fn extension(mime: &str) -> &'static str {
    let m = mime.to_ascii_lowercase();
    if m.contains("ogg") {
        "ogg"
    } else if m.contains("mp4") || m.contains("m4a") || m.contains("aac") {
        "m4a"
    } else if m.contains("wav") {
        "wav"
    } else if m.contains("mpeg") || m.contains("mp3") {
        "mp3"
    } else {
        "webm"
    }
}

fn nom_de_clip(mime: &str) -> String {
    let instant = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    format!(
        "dictee-{}-{instant}.{}",
        std::process::id(),
        extension(mime)
    )
}

/// Le dossier temporaire que l'hôte désigne — jamais le disque système quand
/// il en a choisi un autre.
fn clip_dir() -> PathBuf {
    std::env::var("LOCARYN_TEMP_DIR")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map_or_else(std::env::temp_dir, PathBuf::from)
        .join("locaryn-dictaphone")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn le_prefixe_d_url_de_donnees_est_retire() {
        assert_eq!(
            decode("data:audio/webm;base64,AQID").unwrap(),
            vec![1, 2, 3]
        );
        assert_eq!(decode("AQID").unwrap(), vec![1, 2, 3]);
        assert!(decode("pas du base64 !").is_err());
    }

    #[test]
    fn l_extension_suit_le_type_du_navigateur() {
        assert_eq!(extension("audio/webm;codecs=opus"), "webm");
        assert_eq!(extension("audio/ogg;codecs=opus"), "ogg");
        assert_eq!(extension("audio/mp4"), "m4a");
        assert_eq!(extension(""), "webm");
    }

    #[test]
    fn un_clip_vide_est_refuse_sans_lancer_python() {
        let err = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(transcribe_clip(ClipRequest {
                audio_base64: String::new(),
                mime: "audio/webm".into(),
                language: None,
            }))
            .unwrap_err();
        assert!(err.contains("vide"), "{err}");
    }
}
