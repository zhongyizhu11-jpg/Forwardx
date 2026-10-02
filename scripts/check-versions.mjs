import fs from "node:fs";

const root = new URL("../", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), "utf8");

const pkg = JSON.parse(read("package.json"));
const versionsTs = read("shared/versions.ts");
const agentMain = read("agent/main.go");
const fxpMain = read("forwardx-fxp/main.go");
const agentFxpVersion = read("agent/fxp_version.go");
const sharedFxpRuntime = read("shared/fxpRuntime.ts");

const findTsConst = (name) => {
  const match = versionsTs.match(new RegExp(`export const ${name}\\s*=\\s*["']([^"']+)["']`));
  if (!match) throw new Error(`${name} not found in shared/versions.ts`);
  return match[1];
};

const appVersion = findTsConst("APP_VERSION");
const androidAppVersion = findTsConst("ANDROID_APP_VERSION");
const androidApkReleaseVersion = findTsConst("ANDROID_APK_RELEASE_VERSION");
const agentVersion = findTsConst("AGENT_VERSION");
const sharedFxpRuntimeVersion = findTsConst("FXP_RUNTIME_VERSION");
const sharedFxpMinWireVersion = findTsConst("FXP_MIN_WIRE_VERSION");
const agentMinWireFxpVersion = agentFxpVersion.match(/minWireCompatibleFXPVersion\s*=\s*"([^"]+)"/)?.[1];
const agentHandshakeV3Marker = agentFxpVersion.match(/fxpHandshakeV3Marker\s*=\s*"([^"]+)"/)?.[1];
const sharedHandshakeV3Marker = sharedFxpRuntime.match(/FXP_HANDSHAKE_V3_MARKER\s*=\s*"([^"]+)"/)?.[1];
const agentMainVersion = agentMain.match(/var Version\s*=\s*"([^"]+)"/)?.[1];
const fxpRuntimeVersion = fxpMain.match(/fxpRuntimeVersion\s*=\s*"([^"]+)"/)?.[1];

const semverPattern = /^\d+\.\d+\.\d+$/;

const releaseTag = (
  process.env.FORWARDX_RELEASE_TAG
  || (process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : "")
  || (process.env.GITHUB_REF?.startsWith("refs/tags/") ? process.env.GITHUB_REF.slice("refs/tags/".length) : "")
  || ""
).trim();

const errors = [];
if (pkg.version !== appVersion) {
  errors.push(`package.json version ${pkg.version} does not match APP_VERSION ${appVersion}`);
}
if (androidApkReleaseVersion !== appVersion) {
  errors.push(`ANDROID_APK_RELEASE_VERSION ${androidApkReleaseVersion} does not match APP_VERSION ${appVersion}`);
}
if (agentMainVersion !== agentVersion) {
  errors.push(`agent/main.go Version ${agentMainVersion || "(missing)"} does not match AGENT_VERSION ${agentVersion}`);
}
if (!fxpRuntimeVersion) {
  errors.push("fxpRuntimeVersion not found in forwardx-fxp/main.go");
} else if (!semverPattern.test(fxpRuntimeVersion)) {
  errors.push(`FXP runtime version ${fxpRuntimeVersion} must use x.y.z format`);
}
if (fxpRuntimeVersion && sharedFxpRuntimeVersion !== fxpRuntimeVersion) {
  errors.push(`shared/versions.ts FXP_RUNTIME_VERSION ${sharedFxpRuntimeVersion} does not match forwardx-fxp/main.go ${fxpRuntimeVersion}`);
}
if (agentMinWireFxpVersion !== sharedFxpMinWireVersion) {
  errors.push(`agent/fxp_version.go minWireCompatibleFXPVersion ${agentMinWireFxpVersion || "(missing)"} does not match FXP_MIN_WIRE_VERSION ${sharedFxpMinWireVersion}`);
}
// 不认识 -version 的旧 FXP 靠这条握手 v3 的文案区分能不能握手（Agent 和安装脚本各用一份）。
if (!sharedHandshakeV3Marker || agentHandshakeV3Marker !== sharedHandshakeV3Marker) {
  errors.push(`agent/fxp_version.go fxpHandshakeV3Marker does not match shared/fxpRuntime.ts FXP_HANDSHAKE_V3_MARKER`);
} else if (!fxpMain.includes(sharedHandshakeV3Marker)) {
  errors.push(`forwardx-fxp/main.go no longer contains the handshake v3 marker "${sharedHandshakeV3Marker}"; legacy FXP detection relies on it`);
}
if (appVersion === agentVersion) {
  errors.push(`APP_VERSION and AGENT_VERSION are both ${appVersion}; keep panel and Agent version lines separate`);
}
for (const [name, version] of [
  ["APP_VERSION", appVersion],
  ["ANDROID_APP_VERSION", androidAppVersion],
  ["ANDROID_APK_RELEASE_VERSION", androidApkReleaseVersion],
  ["AGENT_VERSION", agentVersion],
  ["FXP_RUNTIME_VERSION", sharedFxpRuntimeVersion],
  ["FXP_MIN_WIRE_VERSION", sharedFxpMinWireVersion],
]) {
  if (!semverPattern.test(version)) errors.push(`${name} ${version} must use x.y.z format`);
}
if (releaseTag && releaseTag !== `v${appVersion}`) {
  errors.push(`release tag ${releaseTag} does not match APP_VERSION v${appVersion}`);
}
if (errors.length) {
  console.error(errors.map((line) => `- ${line}`).join("\n"));
  process.exit(1);
}

console.log(`versions ok: panel=${appVersion} android=${androidAppVersion} apkRelease=${androidApkReleaseVersion} agent=${agentVersion} fxp=${fxpRuntimeVersion}${releaseTag ? ` tag=${releaseTag}` : ""}`);
