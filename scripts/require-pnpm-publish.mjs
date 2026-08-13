/**
 * Refuse to publish a workspace package with `npm publish`.
 *
 * pnpm rewrites `workspace:*` into the real version when it builds the tarball. `npm` has never
 * heard of the protocol and ships the literal string, which produces a package that *looks*
 * published and cannot be installed:
 *
 *     npm error Unsupported URL Type "workspace:": workspace:*
 *
 * That is how `wise-excavate@0.1.0` reached the registry broken. Nothing in the publish output
 * hints at it — the tarball lists correctly, the version appears on npmjs.com, and the failure
 * only surfaces on the first `npx`, by which time the version number is burned and the fix is a
 * deprecation plus a bump.
 *
 * Wired in as `prepublishOnly`, so it runs under both package managers and blocks only the one
 * that would be wrong. A guard that lives in the manifest cannot be forgotten the way a line in
 * a release checklist can.
 */

import { readFileSync } from 'node:fs';

/**
 * `npm_config_user_agent` is the only signal available here that names the *invoking* tool.
 * pnpm sets `pnpm/10.x npm/? node/...`; npm sets `npm/11.x node/...`. Checking for a leading
 * `npm/` is therefore the discriminator, and an unrecognised agent is allowed through rather
 * than blocked — a false refusal on some future tool would be a worse failure than the one
 * being prevented, because it stops a correct release for no reason.
 */
const agent = process.env.npm_config_user_agent ?? '';
const isNpm = agent.startsWith('npm/');

const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const ranges = Object.entries(manifest.dependencies ?? {});
const workspaceDeps = ranges.filter(([, range]) =>
  String(range).startsWith('workspace:'),
);

if (isNpm && workspaceDeps.length > 0) {
  const list = workspaceDeps.map(([name, range]) => `    ${name}: ${range}`).join('\n');
  process.stderr.write(
    `\nRefusing to publish ${manifest.name} with npm.\n\n` +
      `These ranges use pnpm's workspace protocol, which npm publishes verbatim:\n\n` +
      `${list}\n\n` +
      `The result installs nowhere: \`Unsupported URL Type "workspace:"\`.\n` +
      `Use pnpm, which rewrites them to the real version:\n\n` +
      `    pnpm publish --access public\n\n`,
  );
  process.exit(1);
}
