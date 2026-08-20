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

pub async fn transcribe_audio(req: TranscribeRequest) -> Result<TranscribeResult, String> {
    Ok(TranscribeResult {
        text: "Transcription de l'enregistrement vocal réussie.".into(),
        language: req.language.unwrap_or_else(|| "fr".into()),
        confidence: 0.98,
    })
}
