(strategy smoke/safe-llm
  (version "1.0.0")
  (scope network:devnet)
  (goal let-rig-select-only-permitted-programs)
  (supervise one-for-one (max-restarts 1) (window-ms 60000)
    (delegate assistant
      (grant llm.invoke.safe)
      (call llm/safe@1 "Use the available DKG Programs to answer the request."))))
