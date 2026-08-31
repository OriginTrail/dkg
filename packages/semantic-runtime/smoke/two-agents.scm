(strategy smoke/two-agents
  (version "1.0.0")
  (scope network:devnet)
  (goal prove-two-live-agents)
  (supervise one-for-one (max-restarts 2) (window-ms 60000)
    (parallel (max 2)
      (delegate observer-alpha
        (emit alpha-started))
      (delegate observer-beta
        (emit beta-started)))))
