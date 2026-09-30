import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const label = 'ru.macbookbro.foreign-prices';
const path = join(homedir(), 'Library/LaunchAgents', `${label}.plist`);
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const nodePath = existsSync('/opt/homebrew/bin/node') ? '/opt/homebrew/bin/node' : process.execPath;
await mkdir(join(homedir(), 'Library/LaunchAgents'), { recursive: true });
await mkdir(join(root, 'data/private'), { recursive: true, mode: 0o700 });
await writeFile(path, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${escape(nodePath)}</string><string>${escape(join(root, 'scripts/foreign-mac-agent.mjs'))}</string></array>
<key>WorkingDirectory</key><string>${escape(root)}</string>
<key>StartInterval</key><integer>60</integer>
<key>RunAtLoad</key><true/>
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${escape(join(root, 'data/private/foreign-mac-agent.log'))}</string>
<key>StandardErrorPath</key><string>${escape(join(root, 'data/private/foreign-mac-agent-error.log'))}</string>
</dict></plist>
`, { mode: 0o600 });
const domain = `gui/${process.getuid()}`;
try { execFileSync('/bin/launchctl', ['bootout', `${domain}/${label}`], { stdio: 'ignore' }); } catch {}
execFileSync('/bin/launchctl', ['bootstrap', domain, path]);
console.log('Автообновление зарубежных цен установлено: раз в час, проверка запросов с сайта раз в минуту.');
