(strategy smoke/llm-agent
  (version "1.0.0")
  (scope network:devnet)
  (goal prove-wasm-owned-llm-invocation)
  (supervise one-for-one (max-restarts 2) (window-ms 60000)
    (delegate investigator
      (grant agent.invoke.investigator)
      (emit llm-started)
      (call agent/investigate@1 "Reply with exactly: semantic-runtime-llm-ok")
      (emit llm-finished))))
