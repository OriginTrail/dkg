import { z } from 'zod';
import { createKafkaPlugin } from '@origintrail-official/kafka-plugin';

export default createKafkaPlugin({
  extension: {
    schema: z.object({
      externalRef: z.string(),
      sourceRef: z.string(),
    }),
    augment: (parsed) => ({
      '@context': {
        vendor: 'https://vendor.example.com/ontology#',
      },
      'vendor:externalRef': parsed.externalRef,
      'vendor:sourceRef': parsed.sourceRef,
    }),
  },
});
