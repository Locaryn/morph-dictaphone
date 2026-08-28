//! Transcrire un enregistrement, sur la machine, par `faster-whisper`.
//!
//! Aucun envoi : le fichier reste où il est, le modèle tourne ici. C'est tout
//! l'intérêt d'un dictaphone qui écoute des réunions, des notes ou des
//! consultations.
//!
//! Le morph accepte un **chemin de fichier**, pas un flux encodé en base64.
//! Un enregistrement de dix minutes fait plusieurs mégaoctets ; le passer en
//! argument d'outil le ferait entrer dans la conversation, donc dans le
//! contexte de tous les échanges suivants, pour rien.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

// ── Réglages ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    /// Taille du modèle : `tiny`, `base`, `small`, `medium`, `large-v3`.
    ///
    /// `small` par défaut : c'est le premier qui transcrit correctement le
    /// français, et il tient sur une machine modeste. Les plus gros sont
    /// meilleurs et beaucoup plus lents.
    #[serde(default = "modele_par_defaut")]
    pub model: String,
    /// `cuda` ou `cpu`. Vide : la carte si elle est là, sinon le processeur.
    #[serde(default)]
    pub device: String,
}

fn modele_par_defaut() -> String {
    "small".into()
}

impl Default for Config {
    fn default() -> Self {
        Self {
            model: modele_par_defaut(),
            device: String::new(),
        }
    }
}

pub fn config() -> Config {
    let Some(p) = std::env::var("LOCARYN_EXTENSION_CONFIG_FILE")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
    else {
        return Config::default();
    };
    std::fs::read_to_string(p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

// ── Demande et réponse ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscribeRequest {
    /// Chemin de l'enregistrement sur cette machine. WAV, MP3, M4A, OGG,
    /// FLAC — tout ce que ffmpeg sait ouvrir.
    pub file_path: String,
    /// Code de langue ISO. Absent : whisper la devine.
    #[serde(default)]
    pub language: Option<String>,
    /// Modèle à employer, s'il doit différer du réglage.
    #[serde(default)]
    pub model: Option<String>,
}

/// Un passage, avec sa place dans l'enregistrement.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Segment {
    pub start: f32,
    pub end: f32,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscribeResult {
    pub text: String,
    /// La langue reconnue, ou celle qu'on a imposée.
    pub language: String,
    /// La confiance de whisper dans la langue, entre 0 et 1. C'est la seule
    /// confiance qu'il rende : il n'en donne aucune sur les mots.
    pub language_probability: f32,
    /// Durée de l'audio, telle que whisper la mesure.
    pub duration_seconds: f32,
    pub segments: Vec<Segment>,
    pub model: String,
}

// ── Transcription ───────────────────────────────────────────────────────────

/// Transcrire un enregistrement.
pub async fn transcribe_audio(req: TranscribeRequest) -> Result<TranscribeResult, String> {
    let chemin = PathBuf::from(&req.file_path);
    if !chemin.is_file() {
        return Err(format!("Fichier introuvable : {}", chemin.display()));
    }
    let cfg = config();
    let modele = req
        .model
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .unwrap_or(&cfg.model)
        .to_string();

    let python = find_python()
        .ok_or_else(|| "Python introuvable. Installez Python 3.10 ou plus récent.".to_string())?;

    let langue = req
        .language
        .as_deref()
        .map(str::trim)
        .filter(|l| !l.is_empty() && *l != "auto");

    let script = format!(
        r#"
import sys, json
chemin = {chemin}
modele = {modele}
langue = {langue}
device_voulu = {device}

try:
    from faster_whisper import WhisperModel
except ImportError:
    print("Le paquet `faster-whisper` n'est pas installe dans ce Python.", file=sys.stderr)
    sys.exit(1)

if device_voulu:
    device = device_voulu
else:
    try:
        import torch
        device = "cuda" if torch.cuda.is_available() else "cpu"
    except ImportError:
        device = "cpu"

# int8 sur processeur : sans cela un enregistrement d'une minute prend
# plusieurs minutes, et float16 n'existe pas la.
compute = "float16" if device == "cuda" else "int8"

asr = WhisperModel(modele, device=device, compute_type=compute)
segments, info = asr.transcribe(chemin, beam_size=5, language=langue)

# `segments` est un generateur : il ne travaille qu'a la lecture.
morceaux = [
    {{"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()}}
    for s in segments
]
sortie = {{
    "text": " ".join(m["text"] for m in morceaux).strip(),
    "language": info.language,
    "language_probability": round(float(info.language_probability), 4),
    "duration_seconds": round(float(info.duration), 2),
    "segments": morceaux,
}}
print("<<<RESULTAT>>>" + json.dumps(sortie, ensure_ascii=False))
"#,
        chemin = json_str(&chemin.to_string_lossy()),
        modele = json_str(&modele),
        langue = match langue {
            Some(l) => json_str(l),
            None => "None".to_string(),
        },
        device = if cfg.device.trim().is_empty() {
            "None".to_string()
        } else {
            json_str(cfg.device.trim())
        },
    );

    let sortie = run_python(&python, &script).await?;
    // Whisper écrit ses propres messages sur la sortie standard ; on ne lit
    // que ce qui suit notre marqueur.
    let json_brut = sortie
        .rsplit_once("<<<RESULTAT>>>")
        .map(|(_, apres)| apres.trim())
        .ok_or_else(|| {
            format!(
                "La transcription n'a rien rendu d'exploitable. Fin de la sortie : {}",
                queue(&sortie, 300)
            )
        })?;

    #[derive(Deserialize)]
    struct Brut {
        text: String,
        language: String,
        language_probability: f32,
        duration_seconds: f32,
        segments: Vec<Segment>,
    }
    let b: Brut = serde_json::from_str(json_brut)
        .map_err(|e| format!("Réponse de la transcription illisible : {e}"))?;

    Ok(TranscribeResult {
        text: b.text,
        language: b.language,
        language_probability: b.language_probability,
        duration_seconds: b.duration_seconds,
        segments: b.segments,
        model: modele,
    })
}

// ── Utilitaires ─────────────────────────────────────────────────────────────

/// Un littéral Python sûr : on passe par JSON, dont la syntaxe de chaîne est
/// compatible. Sans cela, un chemin Windows glisse ses antislashs dans le
/// script.
fn json_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

fn queue(s: &str, n: usize) -> String {
    let t = s.trim();
    if t.chars().count() <= n {
        return t.to_string();
    }
    t.chars().skip(t.chars().count() - n).collect()
}

/// Le Python à utiliser : l'environnement géré par l'application d'abord, puis
/// celui du PATH.
pub fn find_python() -> Option<String> {
    for venv in venvs() {
        let exe = if cfg!(windows) {
            venv.join("Scripts").join("python.exe")
        } else {
            venv.join("bin").join("python")
        };
        if exe.exists() {
            return Some(exe.to_string_lossy().to_string());
        }
    }
    if let Ok(out) = std::process::Command::new("python")
        .arg("--version")
        .output()
    {
        if out.status.success() {
            return Some("python".to_string());
        }
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        if let Ok(entries) = std::fs::read_dir(Path::new(&local).join("Programs").join("Python")) {
            for entry in entries.flatten() {
                let exe = entry.path().join("python.exe");
                if exe.exists() {
                    return Some(exe.to_string_lossy().to_string());
                }
            }
        }
    }
    None
}

fn venvs() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(v) = std::env::var("LOCARYN_PYTHON_VENV") {
        if !v.trim().is_empty() {
            out.push(PathBuf::from(v));
        }
    }
    for key in ["LOCARYN_MODELS_DIR", "LOCARYN_EXTENSION_MODELS_DIR"] {
        if let Ok(dir) = std::env::var(key) {
            if let Some(parent) = Path::new(&dir).parent() {
                out.push(parent.join("python-env"));
                out.push(parent.join(".venv"));
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        out.push(cwd.join(".venv"));
    }
    out
}

/// L'environnement que doit hériter Python.
///
/// Le cache HuggingFace suit ce que l'hôte désigne : sans cela le modèle
/// whisper — plusieurs centaines de mégaoctets — atterrit dans `~/.cache` et
/// remplit le disque système.
fn python_env() -> Vec<(&'static str, String)> {
    let mut env = vec![
        ("TRANSFORMERS_NO_TF", "1".to_string()),
        ("USE_TF", "0".to_string()),
        ("TF_CPP_MIN_LOG_LEVEL", "3".to_string()),
    ];
    if let Ok(hf) = std::env::var("LOCARYN_HF_CACHE_DIR") {
        if !hf.trim().is_empty() {
            let _ = std::fs::create_dir_all(&hf);
            env.push(("HF_HOME", hf));
        }
    }
    if let Ok(tmp) = std::env::var("LOCARYN_TEMP_DIR") {
        if !tmp.trim().is_empty() {
            let _ = std::fs::create_dir_all(&tmp);
            env.push(("TMPDIR", tmp.clone()));
            env.push(("TEMP", tmp.clone()));
            env.push(("TMP", tmp));
        }
    }
    env
}

/// Lancer `python -c <script>` et rendre sa sortie standard.
async fn run_python(python: &str, script: &str) -> Result<String, String> {
    let out = tokio::process::Command::new(python)
        .envs(python_env())
        .arg("-c")
        .arg(script)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("impossible de lancer Python : {e}"))?;

    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
    }
    // Une trace Python complète noie le message utile ; ses dernières lignes
    // le portent.
    let err = String::from_utf8_lossy(&out.stderr);
    let lignes: Vec<&str> = err.lines().filter(|l| !l.trim().is_empty()).collect();
    let msg = lignes
        .iter()
        .rev()
        .take(3)
        .rev()
        .cloned()
        .collect::<Vec<_>>()
        .join(" / ");
    Err(if msg.is_empty() {
        format!("la transcription s'est arrêtée ({})", out.status)
    } else {
        msg
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Un chemin Windows contient des antislashs : injecté brut dans le script
    /// Python, il produirait des séquences d'échappement.
    #[test]
    fn les_chemins_partent_en_litteraux_python_surs() {
        assert_eq!(json_str(r"C:\sons\a.wav"), r#""C:\\sons\\a.wav""#);
    }

    #[test]
    fn un_fichier_absent_est_refuse_sans_lancer_python() {
        let err = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(transcribe_audio(TranscribeRequest {
                file_path: "n-existe-pas-du-tout.wav".into(),
                language: None,
                model: None,
            }))
            .unwrap_err();
        assert!(err.contains("introuvable"), "{err}");
    }

    #[test]
    fn la_queue_de_sortie_est_bornee() {
        let long = "x".repeat(1000);
        assert_eq!(queue(&long, 50).chars().count(), 50);
        assert_eq!(queue("court", 50), "court");
    }

    /// Le réglage par défaut doit rester utilisable sans fichier de
    /// configuration : c'est le premier lancement.
    #[test]
    fn les_reglages_par_defaut_tiennent_debout() {
        std::env::remove_var("LOCARYN_EXTENSION_CONFIG_FILE");
        let c = config();
        assert_eq!(c.model, "small");
        assert!(c.device.is_empty(), "l'appareil se devine");
    }

    /// Une vraie transcription, sur cette machine. Ignoré par défaut : il
    /// télécharge le modèle au premier passage.
    /// `cargo test -- --ignored --nocapture`
    #[test]
    #[ignore = "télécharge un modèle whisper et exige un fichier audio"]
    fn transcrit_reellement_un_enregistrement() {
        let Ok(chemin) = std::env::var("MORPH_DICTAPHONE_TEST_AUDIO") else {
            eprintln!("MORPH_DICTAPHONE_TEST_AUDIO non défini ; rien à éprouver");
            return;
        };
        let res = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(transcribe_audio(TranscribeRequest {
                file_path: chemin,
                language: None,
                model: std::env::var("MORPH_DICTAPHONE_TEST_MODEL").ok(),
            }))
            .expect("la transcription doit aboutir");
        println!(
            "langue {} ({:.2}) — {:.1}s — {} segment(s)\ntexte : {}",
            res.language,
            res.language_probability,
            res.duration_seconds,
            res.segments.len(),
            res.text
        );
        assert!(!res.text.trim().is_empty(), "aucun texte rendu");
        assert!(res.duration_seconds > 0.0);
    }
}
