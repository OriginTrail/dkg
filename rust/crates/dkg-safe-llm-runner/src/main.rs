//! Native Rig loop for the typed `safe-llm` host adapter.

use std::{
    collections::HashSet,
    env,
    error::Error,
    io::{self, BufRead, BufReader, Write},
    sync::{Arc, Mutex},
};

use rig_agent::{
    client::AgentClientExt,
    tool::{DynamicTool, ToolExecutionError, ToolOutput},
};
use rig_core::providers::openai;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const MAX_LINE_BYTES: usize = 1_048_576;
const MAX_PROMPT_BYTES: usize = 65_536;
const MAX_TOOLS: usize = 32;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Start {
    prompt: String,
    model: String,
    base_url: String,
    max_turns: usize,
    max_tokens: u64,
    tools: Vec<ToolSpec>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolSpec {
    capability_id: String,
    name: String,
    description: String,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum HostMessage {
    Result {
        id: u64,
        ok: bool,
        output: Option<String>,
        error: Option<String>,
    },
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum RunnerMessage<'a> {
    Call {
        id: u64,
        #[serde(rename = "capabilityId")]
        capability_id: &'a str,
    },
    Complete {
        output: &'a str,
    },
    Error {
        message: &'a str,
    },
}

struct Ipc {
    input: BufReader<io::Stdin>,
    output: io::Stdout,
    next_id: u64,
}

impl Ipc {
    fn call(&mut self, capability_id: &str) -> Result<String, ToolExecutionError> {
        self.next_id = self.next_id.saturating_add(1);
        let id = self.next_id;
        write_message(&mut self.output, &RunnerMessage::Call { id, capability_id })
            .map_err(|error| ToolExecutionError::other(error.to_string()))?;
        let line = read_line(&mut self.input)
            .map_err(|error| ToolExecutionError::other(error.to_string()))?;
        match serde_json::from_str::<HostMessage>(&line)
            .map_err(|_| ToolExecutionError::other("invalid host response"))?
        {
            HostMessage::Result {
                id: result_id,
                ok,
                output,
                error: _,
            } if result_id == id && ok => {
                output.ok_or_else(|| ToolExecutionError::other("host result omitted output"))
            }
            HostMessage::Result {
                id: result_id,
                error,
                ..
            } if result_id == id => Err(ToolExecutionError::provider(
                error.unwrap_or_else(|| "program execution failed".into()),
            )),
            HostMessage::Result { .. } => {
                Err(ToolExecutionError::other("host response id mismatch"))
            }
        }
    }
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        let message = error.to_string();
        let _ = write_message(
            &mut io::stdout(),
            &RunnerMessage::Error { message: &message },
        );
        eprintln!("safe LLM runner failed: {message}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), Box<dyn Error>> {
    let mut input = BufReader::new(io::stdin());
    let start = serde_json::from_str::<Start>(&read_line(&mut input)?)?;
    validate_start(&start)?;
    // Rig's OpenAI-compatible client requires a bearer value at construction
    // time. Local llama.cpp servers do not require credentials, so keep this
    // implementation detail inside the runner instead of making operators
    // configure a fake key.
    let api_key = env::var("OPENAI_API_KEY").unwrap_or_else(|_| "local-no-auth".into());
    let ipc = Arc::new(Mutex::new(Ipc {
        input,
        output: io::stdout(),
        next_id: 0,
    }));
    let tools = start
        .tools
        .iter()
        .cloned()
        .map(|spec| {
            let ipc = Arc::clone(&ipc);
            DynamicTool::new(
                spec.name,
                spec.description,
                json!({
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false
                }),
                move |_context, arguments: Value| {
                    let ipc = Arc::clone(&ipc);
                    let capability_id = spec.capability_id.clone();
                    Box::pin(async move {
                        if !arguments.as_object().is_some_and(serde_json::Map::is_empty) {
                            return Err(ToolExecutionError::other(
                                "this program takes no arguments",
                            ));
                        }
                        let output = ipc
                            .lock()
                            .map_err(|_| ToolExecutionError::other("host channel lock failed"))?
                            .call(&capability_id)?;
                        Ok(ToolOutput::text(output))
                    })
                },
            )
        })
        .collect();

    let client = openai::Client::builder()
        .api_key(api_key)
        .base_url(start.base_url)
        .build()?
        .completions_api();
    let agent = client
        .agent(start.model)
        .preamble(
            "Use only the explicitly provided program tools when a tool is needed. Each tool is a zero-argument DKG Program and returns its persisted Execution result.",
        )
        .default_max_turns(start.max_turns)
        .max_tokens(start.max_tokens)
        .dynamic_tools(tools)
        .build();
    let response = agent
        .runner(start.prompt)
        .max_turns(start.max_turns)
        .tool_concurrency(1)
        .run()
        .await?;
    write_message(
        &mut ipc.lock().map_err(|_| "host channel lock failed")?.output,
        &RunnerMessage::Complete {
            output: &response.output,
        },
    )?;
    Ok(())
}

fn validate_start(start: &Start) -> Result<(), Box<dyn Error>> {
    if start.prompt.is_empty() || start.prompt.len() > MAX_PROMPT_BYTES {
        return Err("prompt must contain 1..65536 UTF-8 bytes".into());
    }
    if start.model.is_empty() || start.base_url.is_empty() {
        return Err("model and baseUrl are required".into());
    }
    if !(2..=8).contains(&start.max_turns) || start.max_tokens == 0 || start.max_tokens > 4096 {
        return Err("safe LLM budget is invalid".into());
    }
    if start.tools.is_empty() || start.tools.len() > MAX_TOOLS {
        return Err("safe LLM requires 1..32 tools".into());
    }
    let mut names = HashSet::new();
    let mut capabilities = HashSet::new();
    for tool in &start.tools {
        if tool.name.is_empty()
            || tool.description.is_empty()
            || !names.insert(tool.name.as_str())
            || !capabilities.insert(tool.capability_id.as_str())
        {
            return Err("safe LLM tools must have unique names and capabilities".into());
        }
    }
    Ok(())
}

fn read_line(reader: &mut impl BufRead) -> io::Result<String> {
    let mut line = String::new();
    let bytes = reader.read_line(&mut line)?;
    if bytes == 0 {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "host channel closed",
        ));
    }
    if bytes > MAX_LINE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "host message too large",
        ));
    }
    Ok(line)
}

fn write_message(writer: &mut impl Write, message: &RunnerMessage<'_>) -> io::Result<()> {
    serde_json::to_writer(&mut *writer, message)?;
    writer.write_all(b"\n")?;
    writer.flush()
}
