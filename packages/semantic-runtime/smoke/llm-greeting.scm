(strategy demo/llm-greeting
  (version "1.1.0")
  (scope network:devnet)
  (goal let-the-llm-respond-freely)
  (supervise one-for-one (max-restarts 2) (window-ms 60000)
    (delegate investigator
      (grant agent.invoke.investigator)
      (emit llm-invocation-started)
      (call agent/investigate@1 "Say anything you like in one short sentence.")
      (emit llm-invocation-finished))))
