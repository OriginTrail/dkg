Buyer journals as the gateway and access keys at testnet-canary 369cbfc032 wrote them, for
`gateway-legacy-journals.test.ts`: epoch 1 made final (a held call, a refused one that landed,
a second key charged and revoked, the keys compacted), and epoch 3 live (held, refused for good,
unanswered, a receipt failing a check, and a call sent when the node stopped).
