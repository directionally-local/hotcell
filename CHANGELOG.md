# Changelog

## [0.1.35](https://github.com/directionally-local/hotcell/compare/v0.1.34...v0.1.35) (2026-10-29)


### Features

* **image:** ship tsrs in the base sandbox image ([#57](https://github.com/directionally-local/hotcell/issues/57)) ([c3962b5](https://github.com/directionally-local/hotcell/commit/c3962b54962654b335d33434066ac8eed87df28c)), closes [#18](https://github.com/directionally-local/hotcell/issues/18)

## [0.1.34](https://github.com/directionally-local/hotcell/compare/v0.1.33...v0.1.34) (2026-10-29)


### Features

* **api:** single route table as the source of truth ([#54](https://github.com/directionally-local/hotcell/issues/54)) ([dbb750e](https://github.com/directionally-local/hotcell/commit/dbb750e9d5cce253529da26e1ea18d1842e74d58))
* **firecracker:** snapshot-fork microVM templates ([#50](https://github.com/directionally-local/hotcell/issues/50)) ([dce9577](https://github.com/directionally-local/hotcell/commit/dce9577c545a7921a4a7a36515b6eefbf45bb7e9))


### Fixes

* **egress:** auto-wire /v1 for OpenAI-SDK providers; test Responses usage ([#55](https://github.com/directionally-local/hotcell/issues/55)) ([1e1ecd8](https://github.com/directionally-local/hotcell/commit/1e1ecd8af9f4c3a5c137ad95ff5001d6ea85ad67))
* **release:** bump docs/openapi.json version in release PRs ([#56](https://github.com/directionally-local/hotcell/issues/56)) ([0a4e7ab](https://github.com/directionally-local/hotcell/commit/0a4e7ab13068ffb3076e87d904a205fcdfdc2552))

## [0.1.33](https://github.com/directionally-local/hotcell/compare/v0.1.32...v0.1.33) (2026-10-28)


### Performance

* **container:** add bounded warm pool ([#46](https://github.com/directionally-local/hotcell/issues/46)) ([f3d43c8](https://github.com/directionally-local/hotcell/commit/f3d43c8832d9c10901fee76b8ad6611c7be3c495))

## [0.1.32](https://github.com/directionally-local/hotcell/compare/v0.1.31...v0.1.32) (2026-10-28)


### Fixes

* **container:** support authenticated TCP agent transport ([#44](https://github.com/directionally-local/hotcell/issues/44)) ([08bc316](https://github.com/directionally-local/hotcell/commit/08bc316786832f3739249b1a6281d82ef529caa1))

## [0.1.31](https://github.com/directionally-local/hotcell/compare/v0.1.30...v0.1.31) (2026-10-28)


### Performance

* **container:** route sandbox operations through guest agent ([#41](https://github.com/directionally-local/hotcell/issues/41)) ([05bf6d5](https://github.com/directionally-local/hotcell/commit/05bf6d506fe833374f3b840ae9d5ef702992c490))

## [0.1.30](https://github.com/sinameraji/hotcell/compare/v0.1.29...v0.1.30) (2026-10-24)


### Fixes

* **image:** rebuild the base image fresh so it gets Debian security fixes ([#34](https://github.com/sinameraji/hotcell/issues/34)) ([7dfe1f7](https://github.com/sinameraji/hotcell/commit/7dfe1f7e17fa740d6a8dbf0a0477263fb0924f99))

## [0.1.29](https://github.com/sinameraji/hotcell/compare/v0.1.28...v0.1.29) (2026-10-24)


### Fixes

* **daemon:** warn at startup on Node with the Brotli RCE (CVE-2026-111497) ([#32](https://github.com/sinameraji/hotcell/issues/32)) ([f5cd741](https://github.com/sinameraji/hotcell/commit/f5cd7412c4a3f0a45322b99818cb76e25cdb95ce))

## [0.1.28](https://github.com/sinameraji/hotcell/compare/v0.1.27...v0.1.28) (2026-10-23)


### Fixes

* **egress:** make spend caps hard ceilings with pre-flight cost reservation ([#30](https://github.com/sinameraji/hotcell/issues/30)) ([37e65ce](https://github.com/sinameraji/hotcell/commit/37e65ce576fec848b94ab240deed1bf6c825d53a))

## [0.1.27](https://github.com/sinameraji/hotcell/compare/v0.1.26...v0.1.27) (2026-10-23)


### Daemon

* audit sandbox.create repo URLs with the shared redactor ([#27](https://github.com/sinameraji/hotcell/issues/27)) ([98b3933](https://github.com/sinameraji/hotcell/commit/98b3933d12000d0b3cf294628586ae1c5ec49f5a))
* firewall networked Firecracker TAPs off host services and cloud metadata ([#22](https://github.com/sinameraji/hotcell/issues/22)) ([003bc33](https://github.com/sinameraji/hotcell/commit/003bc33ff3a04283612d530556f2b98f48df652a))
* gateway relays provider redirects instead of following them ([#24](https://github.com/sinameraji/hotcell/issues/24)) ([7ba10b2](https://github.com/sinameraji/hotcell/commit/7ba10b29c8abe5c02d75674f819265f2c4c4bb20))
* keep config.json and state.db owner-only (0600, home dir 0700) ([#23](https://github.com/sinameraji/hotcell/issues/23)) ([ff10eac](https://github.com/sinameraji/hotcell/commit/ff10eac8ef5447631e1474e289f16f070a05c42c))
* redact credentials in driver logs; validate backup ids in BackupRegistry ([#26](https://github.com/sinameraji/hotcell/issues/26)) ([5a374e3](https://github.com/sinameraji/hotcell/commit/5a374e3c4eb367ee1a4999ecf0da3bbaeebb0d17))
* require an API key by default and refuse cross-site browser requests ([#21](https://github.com/sinameraji/hotcell/issues/21)) ([0ea3619](https://github.com/sinameraji/hotcell/commit/0ea3619bdc6587ded8142a2d50a536ed3c47063e))


### Build and dependencies

* base image on Node 22, published as hotcell-base:node&lt;major&gt; and smoke-tested before :latest moves ([#19](https://github.com/sinameraji/hotcell/issues/19)) ([644901d](https://github.com/sinameraji/hotcell/commit/644901df49b188c63c184f99d23b05a3f3f94b3f))
* bump transitive @grpc/grpc-js to 1.14.6 and protobufjs to 7.6.6 ([#25](https://github.com/sinameraji/hotcell/issues/25)) ([1393d01](https://github.com/sinameraji/hotcell/commit/1393d01752c87f159aa8cf9f73f18729d0b54705))
