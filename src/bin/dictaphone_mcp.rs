//! Stdio MCP server shipped by plugin-dictaphone.
use locaryn_plugin_dictaphone::{transcribe_audio, TranscribeRequest};
use serde_json::{json, Value};
use std::io::Write;
use tokio::io::{AsyncBufReadExt, BufReader};

const VERSION: &str = env!("CARGO_PKG_VERSION");

#[tokio::main]
async fn main() {
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<Value>(&line) {
            Ok(request) => handle_request(request).await,
            Err(error) => error_response(Value::Null, -32700, format!("JSON invalide : {error}")),
        };
        if let Ok(serialized) = serde_json::to_string(&response) {
            println!("{serialized}");
            let _ = std::io::stdout().flush();
        }
    }
}

async fn handle_request(request: Value) -> Value {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let method = request
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match method {
        "initialize" => success(
            id,
            json!({
                "protocolVersion": "2025-06-18",
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "plugin-dictaphone", "version": VERSION }
            }),
        ),
        "tools/list" => success(id, tools_list()),
        "tools/call" => {
            let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let args = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            match call_tool(name, args).await {
                Ok(value) => success(id, text_content(value)),
                Err(error) => error_response(id, -32000, error),
            }
        }
        notification if notification.starts_with("notifications/") => Value::Null,
        _ => error_response(id, -32601, format!("méthode MCP inconnue : {method}")),
    }
}

fn tools_list() -> Value {
    json!({
        "tools": [
            {
                "name": "transcribe_audio",
                "description": "Transcrit un enregistrement présent sur cette machine, par whisper, sans rien envoyer ailleurs. Rend le texte, la langue reconnue, la durée et les passages horodatés. Le premier appel télécharge le modèle.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "file_path": {
                            "type": "string",
                            "description": "Chemin du fichier audio sur cette machine (WAV, MP3, M4A, OGG, FLAC)"
                        },
                        "language": {
                            "type": "string",
                            "description": "Code ISO de la langue (fr, en, ja…). Omis : whisper la devine."
                        },
                        "model": {
                            "type": "string",
                            "description": "tiny, base, small, medium ou large-v3. Omis : le réglage du morph (small). Plus gros = meilleur et bien plus lent."
                        }
                    },
                    "required": ["file_path"]
                }
            }
        ]
    })
}

async fn call_tool(name: &str, args: Value) -> Result<Value, String> {
    match name {
        "transcribe_audio" => {
            let req: TranscribeRequest =
                serde_json::from_value(args).map_err(|e| format!("Paramètres invalides: {e}"))?;
            let res = transcribe_audio(req).await?;
            Ok(json!(res))
        }
        _ => Err(format!("Outil dictaphone inconnu : {name}")),
    }
}

fn text_content(value: Value) -> Value {
    json!({ "content": [{ "type": "text", "text": serde_json::to_string(&value).unwrap_or_else(|_| "{}".into()) }] })
}
fn success(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}
fn error_response(id: Value, code: i64, message: String) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}
