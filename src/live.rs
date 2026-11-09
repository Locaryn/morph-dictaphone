//! La transcription en direct, pour le bouton micro.
//!
//! Une dictée classique lance Python, charge whisper, transcrit, s'arrête :
//! plusieurs secondes avant le premier mot. En direct, le panneau envoie le
//! micro par blocs de quelques centaines de millisecondes ; un processus
//! Python reste donc chargé le temps de la dictée et rend le texte au fil de
//! l'eau (Nemotron 3.5 ASR, encodeur à cache et décodeur RNN-T). Il s'arrête
//! seul après [`REPOS`] sans appel, et rend alors sa mémoire vidéo.
//!
//! Le modèle se déclare dans le catalogue du morph (`dist/marketplace.json`) :
//! c'est de là que vient son dépôt, et l'application l'installe comme les
//! autres. Ce module se contente de le retrouver sur le disque.

use crate::{find_python, python_env, run_python_args};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::Mutex;

/// Le programme du processus de transcription.
const WORKER: &str = include_str!("live_worker.py");
/// Le préfixe des réponses du processus ; le reste de sa sortie est ignoré.
const MARQUE: &str = "@@LIVE@@";
/// La capacité qui désigne, dans le catalogue, le modèle de transcription en
/// direct.
const CAPACITE: &str = "speech-to-text-streaming";
/// Sans appel pendant ce temps, le processus s'arrête et libère la carte.
const REPOS: Duration = Duration::from_secs(120);
/// En dessous de cette mémoire vidéo libre, le processeur prend le relais :
/// le modèle de conversation garde sa place.
const VRAM_MIN_MB: u32 = 1800;
/// Le premier chargement lit 2,5 Go et préchauffe la carte.
const DELAI_CHARGEMENT: Duration = Duration::from_secs(240);
const DELAI_BLOC: Duration = Duration::from_secs(20);
/// Les paquets que la transcription en direct ajoute à ceux de la dictée.
/// `transformers` porte le modèle depuis 5.13 ; `librosa` calcule son
/// spectrogramme.
const PAQUETS: [&str; 2] = ["transformers>=5.13", "librosa>=0.10"];
/// Les paquets sont-ils là, en version suffisante ? Lu dans leurs
/// métadonnées, sans les importer : importer torch prend plusieurs secondes,
/// et le bouton attend cette réponse avant d'ouvrir le micro.
const SONDE: &str = "from importlib.metadata import version
version('torch'); version('librosa')
v = tuple(int(x) for x in version('transformers').split('.')[:2])
assert v >= (5, 13), v";

struct Processus {
    enfant: Child,
    entree: ChildStdin,
    sortie: Lines<BufReader<ChildStdout>>,
    dernier_appel: Instant,
    infos: Value,
}

fn processus() -> &'static Mutex<Option<Processus>> {
    static P: OnceLock<Mutex<Option<Processus>>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(None))
}

// ── Le modèle ───────────────────────────────────────────────────────────────

/// La racine du morph : le binaire vit dans `<racine>/bin/`.
fn racine_du_morph() -> Option<PathBuf> {
    if let Ok(r) = std::env::var("LOCARYN_MORPH_ROOT") {
        if !r.trim().is_empty() {
            return Some(PathBuf::from(r));
        }
    }
    let exe = std::env::current_exe().ok()?;
    exe.parent()?.parent().map(Path::to_path_buf)
}

/// Le dépôt HuggingFace du modèle en direct, lu dans le catalogue du morph.
pub fn depot_du_catalogue(catalogue: &Value) -> Option<String> {
    catalogue
        .get("models")?
        .as_array()?
        .iter()
        .filter(|m| {
            m.get("capabilities")
                .and_then(Value::as_array)
                .is_some_and(|c| c.iter().any(|x| x.as_str() == Some(CAPACITE)))
        })
        .flat_map(|m| {
            m.get("variants")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        })
        .filter_map(|v| v.get("tag").and_then(Value::as_str).map(str::to_string))
        .find_map(|tag| {
            let reste = tag.strip_prefix("https://huggingface.co/")?;
            let mut morceaux = reste.split('/');
            let (a, b) = (morceaux.next()?, morceaux.next()?);
            (!a.is_empty() && !b.is_empty()).then(|| format!("{a}/{b}"))
        })
}

fn depot() -> Option<String> {
    let chemin = racine_du_morph()?.join("dist").join("marketplace.json");
    let texte = std::fs::read_to_string(chemin).ok()?;
    depot_du_catalogue(&serde_json::from_str(&texte).ok()?)
}

/// Les dossiers où l'application range ses modèles.
fn dossiers_modeles() -> Vec<PathBuf> {
    ["LOCARYN_MODELS_DIR", "LOCARYN_EXTENSION_MODELS_DIR"]
        .iter()
        .filter_map(|k| std::env::var(k).ok())
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
        .collect()
}

/// Le dossier du modèle installé : l'application range un dépôt
/// `propriétaire/nom` sous `propriétaire__nom`.
pub fn dossier_installe(depot: &str, dossiers: &[PathBuf]) -> Option<PathBuf> {
    let nom = depot.replace('/', "__");
    dossiers
        .iter()
        .map(|d| d.join(&nom))
        .find(|d| d.join("config.json").is_file() && d.join("model.safetensors").is_file())
}

fn modele() -> Result<PathBuf, String> {
    let depot = depot().ok_or_else(|| {
        "Le catalogue du morph ne déclare aucun modèle de transcription en direct.".to_string()
    })?;
    dossier_installe(&depot, &dossiers_modeles()).ok_or_else(|| {
        format!("Modèle {depot} non installé : installez-le depuis le catalogue des modèles.")
    })
}

// ── Préparation ─────────────────────────────────────────────────────────────

/// Ce qui manque à la transcription en direct.
pub async fn status() -> Value {
    let depot = depot();
    let installe = depot
        .as_deref()
        .and_then(|d| dossier_installe(d, &dossiers_modeles()))
        .is_some();
    let Some(python) = find_python() else {
        return json!({ "ready": false, "model": depot, "model_installed": installe, "packages": false });
    };
    let paquets = run_python_args(&python, &["-c", SONDE]).await.is_ok();
    json!({
        "ready": installe && paquets,
        "model": depot,
        "model_installed": installe,
        "packages": paquets,
    })
}

/// Installer les paquets Python qui manquent. Le modèle, lui, passe par le
/// catalogue de l'application.
pub async fn prepare() -> Result<Value, String> {
    let python = find_python()
        .ok_or_else(|| "Python introuvable. Installez Python 3.10 ou plus récent.".to_string())?;
    if run_python_args(&python, &["-c", SONDE]).await.is_ok() {
        return Ok(json!({ "ready": true, "installed": false }));
    }
    let mut args = vec!["-m", "pip", "install", "--disable-pip-version-check"];
    args.extend(PAQUETS);
    run_python_args(&python, &args)
        .await
        .map_err(|e| format!("L'installation de la transcription en direct a échoué : {e}"))?;
    Ok(json!({ "ready": true, "installed": true }))
}

// ── Le processus ────────────────────────────────────────────────────────────

/// Ce qui fait parler les bibliothèques à chaque passe : barre de chargement
/// des poids, avertissements de génération.
const SILENCE: [(&str, &str); 3] = [
    ("HF_HUB_DISABLE_PROGRESS_BARS", "1"),
    ("TRANSFORMERS_VERBOSITY", "error"),
    ("PYTHONWARNINGS", "ignore"),
];

/// La sortie d'erreur du processus, dans un fichier du dossier temporaire.
/// Héritée, elle partait dans le tube de l'application, qui ne le vidait
/// pas : plein, il figeait le processus puis le serveur (Locaryn/Locaryn#129).
fn journal_du_processus() -> Stdio {
    let chemin = std::env::temp_dir().join("locaryn-dictaphone-direct.log");
    match std::fs::File::create(&chemin) {
        Ok(f) => Stdio::from(f),
        Err(e) => {
            eprintln!(
                "dictaphone : journal {} impossible ({e}), sortie d'erreur ignorée",
                chemin.display()
            );
            Stdio::null()
        }
    }
}

async fn lancer() -> Result<Processus, String> {
    let chemin = modele()?;
    let python = find_python()
        .ok_or_else(|| "Python introuvable. Installez Python 3.10 ou plus récent.".to_string())?;
    let mut commande = std::process::Command::new(&python);
    commande
        .envs(python_env())
        .envs(SILENCE)
        .args(["-u", "-c", WORKER])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(journal_du_processus());
    crate::hide_console(&mut commande);
    let mut enfant = tokio::process::Command::from(commande)
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("impossible de lancer Python : {e}"))?;
    let entree = enfant
        .stdin
        .take()
        .ok_or("entrée du processus indisponible")?;
    let sortie = enfant
        .stdout
        .take()
        .ok_or("sortie du processus indisponible")?;
    let mut p = Processus {
        enfant,
        entree,
        sortie: BufReader::new(sortie).lines(),
        dernier_appel: Instant::now(),
        infos: Value::Null,
    };
    let infos = echanger(
        &mut p,
        &json!({ "op": "load", "model": chemin, "vram_min_mb": VRAM_MIN_MB }),
        DELAI_CHARGEMENT,
    )
    .await?;
    p.infos = infos;
    surveiller_le_repos();
    Ok(p)
}

/// Une requête, sa réponse.
async fn echanger(p: &mut Processus, req: &Value, delai: Duration) -> Result<Value, String> {
    p.dernier_appel = Instant::now();
    let mut ligne = req.to_string();
    ligne.push('\n');
    p.entree
        .write_all(ligne.as_bytes())
        .await
        .map_err(|e| format!("le processus de transcription ne répond plus : {e}"))?;
    p.entree.flush().await.map_err(|e| e.to_string())?;
    let lire = async {
        loop {
            match p.sortie.next_line().await {
                Ok(Some(l)) => {
                    if let Some(json) = l.strip_prefix(MARQUE) {
                        return serde_json::from_str::<Value>(json)
                            .map_err(|e| format!("réponse illisible : {e}"));
                    }
                }
                Ok(None) => return Err("le processus de transcription s'est arrêté".to_string()),
                Err(e) => return Err(e.to_string()),
            }
        }
    };
    let rep = tokio::time::timeout(delai, lire)
        .await
        .map_err(|_| "la transcription en direct ne répond pas à temps".to_string())??;
    if let Some(err) = rep.get("error").and_then(Value::as_str) {
        return Err(err.to_string());
    }
    Ok(rep)
}

/// Une tâche de fond arrête le processus resté sans appel. Elle ne tourne
/// qu'une fois par serveur.
fn surveiller_le_repos() {
    static LANCEE: OnceLock<()> = OnceLock::new();
    if LANCEE.set(()).is_err() {
        return;
    }
    tokio::spawn(async {
        loop {
            tokio::time::sleep(Duration::from_secs(10)).await;
            let mut garde = processus().lock().await;
            let inactif = garde
                .as_ref()
                .is_some_and(|p| p.dernier_appel.elapsed() >= REPOS);
            if inactif {
                if let Some(mut p) = garde.take() {
                    arreter(&mut p).await;
                }
            }
        }
    });
}

async fn arreter(p: &mut Processus) {
    // Poliment d'abord ; s'il ne part pas, de force.
    let quitter = echanger(p, &json!({ "op": "quit" }), Duration::from_secs(3)).await;
    if quitter.is_err() {
        if let Err(e) = p.enfant.kill().await {
            eprintln!("dictaphone : arrêt du processus en direct impossible : {e}");
        }
    }
}

/// Envoyer une requête au processus, en le lançant au besoin. Un processus
/// mort en route est relancé une fois.
async fn appel(req: Value, delai: Duration) -> Result<Value, String> {
    let mut garde = processus().lock().await;
    if garde.is_none() {
        *garde = Some(lancer().await?);
    }
    let p = garde.as_mut().ok_or("processus absent")?;
    match echanger(p, &req, delai).await {
        Ok(v) => Ok(v),
        Err(e) => {
            // L'état du flux est perdu : on repart d'un processus neuf au
            // prochain appel.
            if let Some(mut mort) = garde.take() {
                if let Err(err) = mort.enfant.kill().await {
                    eprintln!("dictaphone : processus en direct déjà arrêté : {err}");
                }
            }
            Err(e)
        }
    }
}

// ── Les outils ──────────────────────────────────────────────────────────────

/// Ouvrir une dictée : charger le modèle s'il ne l'est pas, fixer la langue.
pub async fn start(langue: Option<String>) -> Result<Value, String> {
    let rep = appel(
        json!({ "op": "start", "language": langue.unwrap_or_else(|| "auto".into()) }),
        DELAI_CHARGEMENT,
    )
    .await?;
    let infos = processus()
        .lock()
        .await
        .as_ref()
        .map(|p| p.infos.clone())
        .unwrap_or(Value::Null);
    Ok(json!({ "language": rep.get("language"), "engine": infos }))
}

/// Un bloc de micro : PCM 16 bits, 16 kHz, mono, en base64.
pub async fn audio(pcm: String) -> Result<Value, String> {
    appel(json!({ "op": "audio", "pcm": pcm }), DELAI_BLOC).await
}

/// Clore le segment en cours : son texte, et un numéro. Sa repasse complète
/// arrive plus tard dans `corrections`, sur une réponse suivante.
pub async fn end() -> Result<Value, String> {
    appel(json!({ "op": "end" }), DELAI_BLOC).await
}

/// Relever les repasses terminées, sans rien envoyer.
pub async fn poll() -> Result<Value, String> {
    appel(json!({ "op": "poll" }), DELAI_BLOC).await
}

/// Fin de dictée : faire les repasses en attente et les rendre.
pub async fn drain() -> Result<Value, String> {
    appel(json!({ "op": "drain" }), DELAI_CHARGEMENT).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn le_depot_vient_du_catalogue() {
        let c = json!({ "models": [
            { "capabilities": ["speech-to-text"], "variants": [{ "tag": "https://huggingface.co/a/whisper" }] },
            { "capabilities": ["speech-to-text-streaming"],
              "variants": [{ "tag": "https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b" }] }
        ]});
        assert_eq!(
            depot_du_catalogue(&c).as_deref(),
            Some("nvidia/nemotron-3.5-asr-streaming-0.6b")
        );
        assert_eq!(depot_du_catalogue(&json!({ "models": [] })), None);
    }

    #[test]
    fn le_dossier_suit_la_disposition_de_l_application() {
        let racine = std::env::temp_dir().join(format!("dictaphone-live-{}", std::process::id()));
        let d = racine.join("o__m");
        std::fs::create_dir_all(&d).unwrap();
        assert!(
            dossier_installe("o/m", &[racine.clone()]).is_none(),
            "sans poids"
        );
        std::fs::write(d.join("config.json"), "{}").unwrap();
        std::fs::write(d.join("model.safetensors"), "x").unwrap();
        assert_eq!(dossier_installe("o/m", &[racine.clone()]), Some(d));
        std::fs::remove_dir_all(racine).unwrap();
    }

    #[test]
    fn le_programme_du_processus_porte_sa_marque() {
        assert!(WORKER.contains(MARQUE));
    }
}
