import type { ContextGraphSub } from '@origintrail-official/dkg-agent';

// Source-compatibility fixture: this is the exported subscription shape from
// before sync-admission lanes existed. Runtime normalization supplies the
// admission before an agent stores the value as live state.
const legacySubscription: ContextGraphSub = {
  syncMode: 'always-on',
  subscribed: true,
  synced: false,
};

const currentSubscription: ContextGraphSub = {
  ...legacySubscription,
  syncAdmission: 'automatic-public',
};

void legacySubscription;
void currentSubscription;
