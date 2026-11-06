(strategy smoke/remote-execute
  (version "1.0.0")
  (scope network:devnet)
  (goal execute-child-program-on-target-node)
  (supervise one-for-one (max-restarts 1) (window-ms 60000)
    (delegate composer
      (grant program.remote-execute)
      (call remote-execute@1 "12D3KooWTargetPeer" "urn:sr:program:child"))))
