export const sel = {
  app: '.v10-app',
  appBody: '.v10-app-body',

  header: {
    root: '.v10-header',
    logo: '.v10-header-logo',
    logoText: '.v10-header-logo-text',
    version: '.v10-header-logo-version',
    sidebarToggle: 'button[title="Toggle sidebar"]',
    agentName: '.v10-header-agent-name',
    statusDot: '.v10-header-status-dot',
    meta: '.v10-header-meta',
    notifWrap: '.v10-header-notif-wrap',
    notifBadge: '.v10-header-notif-badge',
    // rc.12 refactor: the bell dropdown is now the standalone NotificationsPane
    // (`<NotificationsBell>` → `<NotificationsPane>`), not the old inline
    // `.v10-header-notif-*` markup. Rows are rendered by JoinRequestRow /
    // ActivityDigestRow / ConfirmationRow (see components/Notifications/).
    notifDropdown: '.v10-notif-pane',
    notifTitle: '.v10-notif-pane-title',
    notifEmpty: '.v10-notif-pane-empty',
    notifItem: '.v10-notif-row',
    notifItemText: '.v10-notif-row-detail',
    notifItemTime: '.v10-notif-time',
    themeToggle: 'button[title*="Switch to"]',
    observabilityBtn: 'button[title="Observability"]',
    settingsBtn: 'button[title="Settings"]',
    rightPanelToggle: 'button[title="Toggle agent panel"]',
    actions: '.v10-header-actions',
  },

  leftPanel: {
    root: '.v10-panel-left',
    treeHeader: '.v10-tree-header',
    modeBtn: '.v10-tree-mode-btn',
    // `.v10-collapse-btn` was removed in PR8 — the in-panel ◂ triangle
    // duplicated the always-visible global header toggle. Use the
    // global header `sidebarToggle` instead. `.v10-tree-section-badge`
    // and `.v10-tree-chevron` were also removed; the per-project
    // chevron-expand pattern no longer exists. Broader e2e
    // modernization is a standalone follow-up (chevron-expand /
    // memory-layer rows / fixture CG names — all gone for multiple
    // PRs); this PR only triages the cases its removals directly broke.
    treeContent: '.v10-tree-content',
    dashboard: '.v10-tree-dashboard',
    newProjectBtn: '.v10-new-project-btn',
    emptyCard: '.v10-journey-empty-card',
    emptyTitle: '.v10-jec-title',
    emptyHint: '.v10-jec-hint',
    section: '.v10-tree-section',
    sectionHeader: '.v10-tree-section-header',
    sectionLabel: '.v10-tree-section-label',
    hideBtn: '.v10-tree-hide-btn',
    showHidden: '.v10-tree-show-hidden',
    treeItems: '.v10-tree-items',
    treeItem: '.v10-tree-item',
    itemLabel: '.v10-tree-item-label',
    layerHeader: '.v10-tree-layer-header',
    oraclePlaceholder: '.v10-oracle-placeholder',
    integrationDot: '.v10-tree-integration-dot',
    // PR8 sibling-section pattern (My Context Graphs + Integrations):
    peerGroup: '.v10-peer-group',
    peerGroupHeader: '.v10-peer-group-header',
    peerGroupLabel: '.v10-peer-group-label',
    peerGroupBody: '.v10-peer-group-body',
  },

  center: {
    root: '.v10-panel-center',
    tabs: '.v10-center-tabs',
    tab: '.v10-center-tab',
    tabLabel: '.v10-center-tab-label',
    tabClose: '.v10-center-tab-close',
    content: '.v10-center-content',
    placeholder: '.v10-view-placeholder',
  },

  bottom: {
    root: '.v10-panel-bottom',
    tabs: '.v10-bottom-tabs',
    tab: '.v10-bottom-tab',
    toggle: '.v10-bottom-toggle',
    content: '.v10-bottom-content',
    logContainer: '.v10-log-container',
    logFilter: '.v10-log-filter',
    logOutput: '.v10-log-output',
    logLine: '.v10-log-line',
  },

  rightPanel: {
    root: '.v10-panel-right',
    modeTab: '.v10-agent-mode-tab',
    subtab: '.v10-agent-subtab',
    subtabGroup: '.v10-agent-subtab-group',
    addBtn: '.v10-agent-subtab.add',
    chatInput: '.v10-agent-input',
    sendBtn: '.v10-agent-send-btn',
    chatMessages: '.v10-chat-messages',
    chatBubble: '.v10-chat-bubble',
    agentCard: '.v10-agent-card',
    connectBtn: '.v10-agent-send-btn.secondary',
    tabMenuTrigger: '.v10-agent-tab-menu-trigger',
    tabMenuPopover: '.v10-agent-tab-menu-popover',
    tabMenuItem: '.v10-agent-tab-menu-item',
    tabMenuItemDanger: '.v10-agent-tab-menu-item.danger',
    sessionItem: '.v10-session-item',
    warning: '.v10-local-agent-warning',
    projectSelect: '.v10-local-agent-target-select',
    projectSelectTrigger: '.v10-local-agent-target-select .v10-select-trigger',
    // The Select menu/options portal to document.body (createPortal), so
    // they're NOT descendants of `.v10-local-agent-target-select`. Use
    // top-level selectors so Playwright actually finds them when the
    // picker is open.
    projectSelectMenu: '.v10-select-menu',
    projectSelectOption: '.v10-select-option',
    // PR2 composer (TextareaAutosize + lucide icons + react-dropzone)
    composerShell: '.v10-local-agent-composer-shell',
    composerAttach: '.v10-composer-attach',
    composerControls: '.v10-composer-controls',
    composerTarget: '.v10-composer-target',
    sendBtnInline: '.v10-local-agent-inline-send',
    sendBtnAria: 'button[aria-label="Send message"]',
    attachmentChips: '.v10-attachment-chips',
    attachmentChip: '.v10-attachment-chip',
    attachmentChipRemove: '.v10-attachment-chip-remove',
    attachmentChipStatus: '.v10-attachment-chip-status',
    messagesRegion: '.v10-local-agent-messages',
    dropOverlay: '.v10-drop-overlay',
    dropOverlayAccept: '.v10-drop-overlay.active.accept',
    dropOverlayRefuse: '.v10-drop-overlay.active.refuse',
    // PR3 markdown rendering (react-markdown + remark-gfm + shiki)
    markdownRoot: '.v10-md',
    markdownParagraph: '.v10-md-p',
    markdownLink: 'a.v10-md-link',
    markdownInlineCode: 'code.v10-md-code',
    markdownTable: '.v10-md-table',
    markdownTableScroll: '.v10-md-table-scroll',
    markdownBlockquote: 'blockquote.v10-md-blockquote',
    markdownPre: '.v10-md-pre',
    markdownPreFallback: '.v10-md-pre-fallback',
    markdownPreRendered: '.v10-md-pre-rendered',
    markdownCopy: '.v10-md-copy',
    markdownCopyAnnounce: '.v10-md-copy-announce',
  },

  dashboard: {
    root: '.v10-dashboard',
    title: '.v10-dash-title',
    subtitle: '.v10-dash-subtitle',
    stats: '.v10-dash-stats',
    statCard: '.stat-card',
    statLabel: '.stat-label',
    statValue: '.stat-value',
    quickAction: '.v10-quick-action',
    quickActionIcon: '.v10-quick-action-icon',
    sectionHeader: '.v10-dash-section-header',
    sectionLink: '.v10-dash-section-link',
    recentOp: '.v10-recent-op',
    recentOpType: '.v10-recent-op-type',
    recentOpStatus: '.v10-recent-op-status',
    projectCard: '.v10-dash-project-card',
    projectName: '.v10-dash-project-name',
    projectCount: '.v10-dash-project-count',
  },

  modal: {
    overlay: '.v10-modal-overlay',
    box: '.v10-modal-box',
    header: '.v10-modal-header',
    title: '.v10-modal-title',
    subtitle: '.v10-modal-subtitle',
    body: '.v10-modal-body',
    footer: '.v10-modal-footer',
    btn: '.v10-modal-btn',
    btnPrimary: '.v10-modal-btn.primary',
    error: '.v10-modal-error',
    tip: '.v10-modal-tip',
    formGroup: '.v10-form-group',
    formLabel: '.v10-form-label',
    formInput: '.v10-form-input',
    formTextarea: '.v10-form-textarea',
    formSelect: '.v10-form-select',
    formRadio: '.v10-form-radio',
    advancedToggle: '.v10-form-advanced-toggle',
    advancedBody: '.v10-form-advanced-body',
    advChevron: '.v10-form-adv-chevron',
    layerPreview: '.v10-layer-preview',
  },

  importModal: {
    dropzone: '.v10-import-dropzone',
    dropzoneLabel: '.v10-import-dropzone-label',
    fileList: '.v10-import-file-list',
    fileItem: '.v10-import-file-item',
    fileName: '.v10-import-file-name',
    fileSize: '.v10-import-file-size',
    fileRemove: '.v10-import-file-remove',
    option: '.v10-import-option',
    progress: '.v10-import-progress',
    progressBar: '.v10-import-progress-bar',
    result: '.v10-import-result',
  },

  resizeHandle: '.v10-resize-handle-h',

  subgraph: {
    bar: '.v10-subgraph-bar',
    barLabel: '.v10-subgraph-bar-label',
    chip: '.v10-subgraph-chip',
    chipActive: '.v10-subgraph-chip.active',
    chipIcon: '.v10-subgraph-chip-icon',
    chipLabel: '.v10-subgraph-chip-label',
    chipCount: '.v10-subgraph-chip-count',
    chipRoot: '.v10-subgraph-chip-root',
    detail: '.v10-subgraph-detail',
    detailTitle: '.v10-subgraph-detail-title',
    crossLayerStrip: '[data-testid="cross-layer-strip"]',
    crossLayerCell: '.v10-subgraph-cross-layer-cell',
    crossLayerCount: '.v10-subgraph-cross-layer-cell-count',
    explorerHeader: '.v10-subgraph-explorer-header',
    explorerTitle: '.v10-subgraph-explorer-title',
    timeline: '.v10-subgraph-timeline',
    timelineItem: '.v10-subgraph-timeline-item',
    badge: '.v10-subgraph-badge',
  },

  statStrip: {
    root: '.v10-stat-strip',
    cell: '.v10-stat-strip-cell',
    value: '.v10-stat-strip-value',
    label: '.v10-stat-strip-label',
    compact: '.v10-stat-strip.compact',
  },

  layer: {
    switcher: '.v10-layer-switcher',
    switchBtn: '.v10-layer-switch-btn',
    actionBtn: '.v10-layer-action-btn',
    detail: '.v10-layer-detail',
    graphCanvas: '[data-testid="rdf-graph"], canvas, .rdf-graph',
    promoteAll: 'button:has-text("Promote All")',
    publishAll: 'button:has-text("Publish")',
  },

  shareModal: {
    title: '.v10-modal-title',
    inviteLabel: '.v10-form-label:has-text("Invite Code")',
    allowedAgents: '.v10-form-label:has-text("Allowed Agents")',
    pendingRequests: '.v10-form-label:has-text("Pending Join Requests")',
    copyInviteBtn: 'button:has-text("Copy Invite")',
  },

  myContextGraphs: {
    peerGroup: '.v10-peer-group',
    peerGroupLabel: '.v10-peer-group-label',
    peerGroupBody: '.v10-peer-group-body',
  },

  // Settings page (pages/Settings.tsx). It is NOT a `.v10-*` surface — the
  // rewritten page uses the shared `.card`/`.settings-*` design-system classes.
  // Opens as a closable center tab from the header gear button.
  settings: {
    pageTitle: '.page-title',
    stack: '.settings-stack',
    card: '.settings-stack .card',
    cardTitle: '.settings-stack .card-title',
    fieldLabel: '.settings-field-label',
    fieldValue: '.settings-field-value',
    onlinePill: '.settings-stack .card-body .mono',
    telemetrySwitch: 'button[role="switch"][aria-label="Share telemetry with the network"]',
    telemetryDialog: '[role="dialog"][aria-label="Enable Telemetry Streaming?"]',
    retentionSelect: '#retention-select',
    retentionConfirm: '[role="group"][aria-label="Confirm retention reduction"]',
    rpcRevealBtn: 'button[aria-label="Reveal RPC URL"]',
    rpcRedactBtn: 'button[aria-label="Redact RPC URL"]',
    shutdownBtn: '.settings-stack .card button',
  },

  // Publishing Conviction (PCA) tab — GREENFIELD (P0). These are the e2e
  // selector CONTRACT for the new node-UI surface (plan §2.3 file targets +
  // PCA-NODE-UI-UX-PROPOSAL screens S1–S7/S2b). data-testid is used for every
  // e2e-critical anchor so specs don't bind to volatile design-system classes;
  // QA owns this map, Frontend adds the matching attributes. Until the tab
  // lands, the spec (publishing-conviction.spec.ts) is `test.fixme`.
  conviction: {
    // Header launch button → openTab({ id:'conviction', ... }) (Header.tsx).
    // Uses a data-testid (not title): the title is the proposal §3.1 benefit-cue
    // tooltip "Publishing Conviction — publishing discounts & sponsorship".
    headerBtn: '[data-testid="pca-launch-btn"]',
    // PublishingConviction.tsx tab root (pages/PublishingConviction.tsx)
    view: '[data-testid="pca-view"]',
    // 503 / FEATURE_UNAVAILABLE mount-gate EmptyState (proposal §6.6/§8a)
    unavailable: '[data-testid="pca-unavailable"]',
    recheckBtn: '[data-testid="pca-recheck-btn"]',
    // S7 role-adaptive landing + S1 overview
    landing: '[data-testid="pca-landing"]',
    trackToggle: '[data-testid="pca-track-toggle"], .v10-pca-track-toggle', // S1 collapsed "track by id" disclosure (expand first)
    trackInput: '[data-testid="pca-track-input"]',         // S1 manual accountId paste (P0 pre-discovery)
    trackSubmit: '[data-testid="pca-track-submit"]',
    accountCard: '[data-testid="pca-account-card"]',        // S1/S3 PcaAccountCard
    healthChip: '[data-testid="pca-health-chip"]',          // HealthChip
    tierLadder: '[data-testid="pca-tier-ladder"]',          // DiscountTierLadder
    // S2 create
    createBtn: '[data-testid="pca-create-btn"]',
    createModal: '[data-testid="pca-create-modal"]',        // CreatePcaModal (mirrors .v10-modal-*)
    createTokensInput: '[data-testid="pca-create-tokens"]',
    createPrimaryNode: '[data-testid="pca-create-primary-node"]',
    createSubmit: '[data-testid="pca-create-submit"]',
    createSuccess: '[data-testid="pca-create-success"]',    // invariant 11: "0/100 wallets approved — discounts nothing yet"
    approveOwnWalletsCta: '[data-testid="pca-approve-own-wallets"]',
    // S3 manage (conviction:<id> detail tab)
    detail: '[data-testid="pca-detail"]',                   // S3 detail root
    agentList: '[data-testid="pca-agent-list"]',            // PcaAgentList (B3)
    agentRow: '[data-testid="pca-agent-row"]',              // WalletRow
    topUpBtn: '[data-testid="pca-topup-btn"]',
    settleBtn: '[data-testid="pca-settle-btn"]',            // permissionless (enabled for everyone)
    deregisterBtn: '[data-testid="pca-deregister-btn"]',    // two-step: shows after "Remove" confirm
    actionResult: '[data-testid="pca-action-result"]',      // funding/settle/bind result line
    // S4 approve wallets
    approveModal: '[data-testid="pca-approve-modal"]',      // ApproveWalletsModal
    approveAddressInput: '[data-testid="pca-approve-address"]',
    approveSubmit: '[data-testid="pca-approve-submit"]',
    // S5 eligibility (predictive in P0; confirmed B8 in P2). The chip renders
    // ONLY in a project's SWM/VM layer view (publish CTA) AND only when ≥1 PCA
    // is tracked → reachable at the capstone/CI-devnet, not a fresh core.
    publishEligibility: '[data-testid="pca-publish-eligibility"]',  // chip wrapper on the SWM→VM publish CTA (layer-widgets)
    eligibilityVerdict: '[data-testid="pca-eligibility-verdict"]', // EligibilityVerdictBanner (role=alert on amber/danger)
    eligibilityChip: '[data-testid="pca-eligibility-chip"]',       // condensed chip label/popover
    verdictWhy: '.v10-pca-verdict-why',                            // "why?" → preflight popover (no testid yet)
    discountBadge: '[data-testid="pca-discount-badge"]',           // DiscountAppliedBadge (B8; degrade-to-hidden)
    // S6 edge onboarding
    getSponsoredPanel: '[data-testid="pca-get-sponsored"]',        // GetSponsoredPanel / SponsorshipHandshake
    // Predictive bell (NotificationsPane "Publishing conviction" section)
    bellAlert: '[data-testid="pca-bell-alert"]',
  },
} as const;
