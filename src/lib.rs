//! Locaryn Dictaphone Plugin
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscribeRequest {
    pub audio_base64: Option<String>,
    pub language: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscribeResult {
    pub text: String,
    pub language: String,
    pub confidence: f32,
}

/// Non implemente. La signature est conservee pour que l'interface et le
/// serveur MCP gardent leur forme, mais l'appel echoue franchement plutot
/// que de fabriquer un resultat.
pub async fn transcribe_audio(_req: TranscribeRequest) -> Result<TranscribeResult, String> {
    Err("La transcription n'est pas implementee : ce morph n'embarque aucun moteur de reconnaissance vocale.".into())
}
