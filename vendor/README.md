# vendor

Packages of Cloud9's own that are not on npm, as the tarballs `npm pack`
makes. `package.json` names them (`"tern": "file:vendor/tern-0.16.1.tgz"`)
and `package-lock.json` has their checksums, so an install needs no GitHub
repository to still be there.

| file | from | commit |
| --- | --- | --- |
| `emmet-0.0.1.tgz` | github.com/cloud9ide/emmet-core | `2ff6dc06ad` |
| `nak-0.3.3.tgz` | github.com/cloud9ide/nak | `6deef931594` |
| `tern-0.16.1.tgz` | github.com/cloud9ide/tern | `39015d544d4c00c7899fea4c95c2e5bc2720e68e` |
| `tern_from_ts-0.0.1.tgz` | github.com/cloud9ide/tern_from_ts | `66df507986bbdd63f3bc4f0c53edb39169ce4f1c` |

To change one: unpack it (`tar xzf`, into `package/`), edit, `npm pack
./package` and put the new tarball here; then `npm install
--package-lock-only` for its new checksum in `package-lock.json`.
