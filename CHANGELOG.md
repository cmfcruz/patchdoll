# Changelog

## 1.0.0 (2026-06-13)


### ⚠ BREAKING CHANGES

* **claude:** pin permission mode to bypassPermissions ([#57](https://github.com/cmfcruz/patchdoll/issues/57))
* gate invocation behind a trusted-users allowlist ([#64](https://github.com/cmfcruz/patchdoll/issues/64))
* **secrets:** require env-based secret configuration ([#60](https://github.com/cmfcruz/patchdoll/issues/60))

### Features

* **core:** add GitHub observe dispatch seam ([#72](https://github.com/cmfcruz/patchdoll/issues/72)) ([9dcc25f](https://github.com/cmfcruz/patchdoll/commit/9dcc25f8b4bc81f06c17434f870e011cc1e511c5))
* gate invocation behind a trusted-users allowlist ([#64](https://github.com/cmfcruz/patchdoll/issues/64)) ([9db05c0](https://github.com/cmfcruz/patchdoll/commit/9db05c03be5a76143129d6fb844f06252f809a50))
* **image:** add container runtime tooling to the agent image ([82e1b48](https://github.com/cmfcruz/patchdoll/commit/82e1b483b5d7b48eca69d7a178eb47758ea08746))
* **progress:** unify Codex and Claude Slack status updates ([#47](https://github.com/cmfcruz/patchdoll/issues/47)) ([8ef59d7](https://github.com/cmfcruz/patchdoll/commit/8ef59d7976e581791429311d5d0c1cb7a119e560))
* **provider-claude:** add Claude Code provider framework ([b546f68](https://github.com/cmfcruz/patchdoll/commit/b546f68a5de3ebe99fa5d55389f7537f50863817))
* **provider-codex:** preflight rollout existence before resume ([623d1ac](https://github.com/cmfcruz/patchdoll/commit/623d1ac87fb94e8d299294155001f61939f5c36c))
* **providers:** add admin-only "reset thread" escape hatch ([f9eb7f2](https://github.com/cmfcruz/patchdoll/commit/f9eb7f24dd14d8fc73fbd3b2b6e9a3df11bce696))
* **settings:** add ai.memoryEnabled override for agent memory ([#34](https://github.com/cmfcruz/patchdoll/issues/34)) ([8d9b079](https://github.com/cmfcruz/patchdoll/commit/8d9b0797a929b5d1d9345a701ef3d77c7ebbe245))


### Bug Fixes

* **adapter-slack:** classify transcript fetch failures ([dfa2a3e](https://github.com/cmfcruz/patchdoll/commit/dfa2a3e76bd718d4b699c0977e80293ef3797eb0))
* **adapter-slack:** classify transcript fetch failures ([579c30d](https://github.com/cmfcruz/patchdoll/commit/579c30d3c3558a9bfc48863de684c1dffaf6a92d)), closes [#17](https://github.com/cmfcruz/patchdoll/issues/17)
* **claude:** allow scoped network reads ([cbadde1](https://github.com/cmfcruz/patchdoll/commit/cbadde1a899f5e95b0d02716f3413a9a9a8c0c7d))
* **claude:** regenerate CLAUDE.md from restored Codex instructions ([4de3d90](https://github.com/cmfcruz/patchdoll/commit/4de3d907abe209325ffa84db28c0ace229471807))
* **codex:** allow scoped network reads ([9e6c5f5](https://github.com/cmfcruz/patchdoll/commit/9e6c5f59811518d9588d00cd2914dbd9f6254ed4))
* **codex:** block secret-adjacent value reads ([f4763a9](https://github.com/cmfcruz/patchdoll/commit/f4763a92fd5ae474b412213c6f732e5677b8085d))
* **codex:** gate Codex agent on network egress, not local actions ([a7dfa82](https://github.com/cmfcruz/patchdoll/commit/a7dfa8295904a93b908bb588d06850e09184d379)), closes [#24](https://github.com/cmfcruz/patchdoll/issues/24)
* **codex:** gate Codex agents on network egress, not local actions ([7aa4c49](https://github.com/cmfcruz/patchdoll/commit/7aa4c498a34089e7c1ce888a34157a34b3ec43f1))
* **codex:** restore provider-specific AGENTS instructions ([2de59be](https://github.com/cmfcruz/patchdoll/commit/2de59bef8c05fb9d24896b900519838b6622c240))
* **core:** infer git identity from gh auth ([#62](https://github.com/cmfcruz/patchdoll/issues/62)) ([c2de954](https://github.com/cmfcruz/patchdoll/commit/c2de954930f4e05236ffba71937090138df824a0))
* **core:** refresh GitHub App tokens per run ([#58](https://github.com/cmfcruz/patchdoll/issues/58)) ([0283008](https://github.com/cmfcruz/patchdoll/commit/0283008e5a199c01fa8b70d0992b7e975afe91c0))
* **instructions:** clarify local approval boundaries ([3b2d662](https://github.com/cmfcruz/patchdoll/commit/3b2d662b5f6c84a72d5ef53686fee9492c5770e9))
* **instructions:** Remove Codex-specific instructions ([ab66349](https://github.com/cmfcruz/patchdoll/commit/ab663491b6481c181f70beaef84a73bb71018464))
* **provider-claude:** stream progress events via stream-json output ([#41](https://github.com/cmfcruz/patchdoll/issues/41)) ([6a4086f](https://github.com/cmfcruz/patchdoll/commit/6a4086ff700db8f8c82d05a78b1edbd7814aa7e4))
* **providers:** anchor resume-failure signatures to resume wording ([7ecd316](https://github.com/cmfcruz/patchdoll/commit/7ecd316d63802a114a807fa79c77592d43bb3c7b))
* **providers:** only self-heal sessions on resume-restoration failures ([59b3fcd](https://github.com/cmfcruz/patchdoll/commit/59b3fcd5f24894221d5d9e1377ea1b09f1555361))
* **providers:** self-heal threads on --resume failure ([f372a95](https://github.com/cmfcruz/patchdoll/commit/f372a95fd950064a621376857f9374a9f9edbb4b))
* **providers:** self-heal threads on --resume failure ([03c91a3](https://github.com/cmfcruz/patchdoll/commit/03c91a3e29fbbe54340757b1ae4878b9f6e909ba)), closes [#13](https://github.com/cmfcruz/patchdoll/issues/13)
* **secrets:** accept env-provided secrets via migrate-and-scrub, drop reject gates ([#55](https://github.com/cmfcruz/patchdoll/issues/55)) ([9bbc1c3](https://github.com/cmfcruz/patchdoll/commit/9bbc1c3d371d3cb6d5340b625db3be0ebec47804))
* **secrets:** require env-based secret configuration ([#60](https://github.com/cmfcruz/patchdoll/issues/60)) ([e675ead](https://github.com/cmfcruz/patchdoll/commit/e675ead1675eaa31d977fb5bf4157e927bb5aa38)), closes [#59](https://github.com/cmfcruz/patchdoll/issues/59)
* **secrets:** round-trip single quotes ([4e75c44](https://github.com/cmfcruz/patchdoll/commit/4e75c442e0cb79dc40750c01f43fec6a9afa0d22))
* **secrets:** single-quote secret values without escaping ([e05a370](https://github.com/cmfcruz/patchdoll/commit/e05a370e5a80b0fdae4a991277230d1395c7512d))
* **slack:** suppress interactive question tools ([#53](https://github.com/cmfcruz/patchdoll/issues/53)) ([8a40c23](https://github.com/cmfcruz/patchdoll/commit/8a40c233821e4568c9ef0e7e1b109acfe4d9d029))
* **slack:** surface missing history scope remediation ([6eb8f2a](https://github.com/cmfcruz/patchdoll/commit/6eb8f2ae38e913e947386281ee65534e9bf9c332))
* **slack:** surface missing history scope remediation ([bbbe935](https://github.com/cmfcruz/patchdoll/commit/bbbe9351efec1a0c7cf0bcc1dd46fa0937e12a02)), closes [#28](https://github.com/cmfcruz/patchdoll/issues/28)
* sync env var overrides into settings DB on startup ([#49](https://github.com/cmfcruz/patchdoll/issues/49)) ([928f3d3](https://github.com/cmfcruz/patchdoll/commit/928f3d379be1368b148cbe9220fad2d5183daf09))


### Code Refactoring

* **claude:** pin permission mode to bypassPermissions ([#57](https://github.com/cmfcruz/patchdoll/issues/57)) ([8173959](https://github.com/cmfcruz/patchdoll/commit/817395902e187c9f60f108668c6e0f7ff682630d))
