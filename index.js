#!/usr/bin/env node

import { program } from 'commander';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import os from 'os';
import { fileURLToPath } from 'url';
import { checkbox, input, password } from '@inquirer/prompts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Jalur berkas konfigurasi lokal di root project
const CONFIG_FILE = path.join(__dirname, 'config.json');

// Pilihan agent tujuan instalasi skill
const HOME_DIR = os.homedir();
const AGENT_TARGETS = {
    copilot: { label: 'GitHub Copilot', dir: path.join(HOME_DIR, '.copilot', 'skills') },
    claude: { label: 'Claude Code', dir: path.join(HOME_DIR, '.claude', 'skills') },
};

let config = null;

// Muat config.json. Jika belum ada, minta SERVER_URL dan PAT lalu simpan ke config.json
async function loadConfig() {
    if (config) return config;

    if (fs.existsSync(CONFIG_FILE)) {
        try {
            config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
            return config;
        } catch (error) {
            throw new Error('Gagal membaca file config.json lokal.');
        }
    }

    console.log(`\x1b[33m[AICHA]\x1b[0m config.json belum ada. Silakan isi konfigurasi berikut.`);
    const serverUrl = await input({
        message: 'Masukkan SERVER_URL (contoh: https://tfs.astra.co.id/tfs)',
        validate: value => value.trim() !== '' || 'SERVER_URL wajib diisi',
    });
    const pat = await password({
        message: 'Masukkan PAT (kosongkan jika repo bersifat publik)',
        mask: '*',
    });

    config = { SERVER_URL: serverUrl.trim(), PAT: pat.trim() };
    return config;
}

// Struktur wajib: <root>/skills/<nama-skill>/SKILL.md
// Nama dicek persis (case-sensitive) dengan membaca nama asli dari disk,
// karena existsSync di Windows tidak membedakan huruf besar-kecil.
function validateSkillStructure(repoRoot) {
    const rootDirs = fs.readdirSync(repoRoot, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name);
    if (!rootDirs.includes('skills')) {
        throw new Error(`Struktur repo tidak valid: folder 'skills' (huruf kecil semua) tidak ditemukan di root repositori.`);
    }

    const sourceSkillsPath = path.join(repoRoot, 'skills');
    const entries = fs.readdirSync(sourceSkillsPath, { withFileTypes: true });

    const invalidEntries = entries.filter(e => !e.isDirectory()).map(e => e.name);
    if (invalidEntries.length > 0) {
        throw new Error(`Struktur repo tidak valid: di dalam 'skills' hanya boleh berisi folder skill, ditemukan file: ${invalidEntries.join(', ')}`);
    }

    const skillNames = entries.map(e => e.name);
    if (skillNames.length === 0) {
        throw new Error(`Struktur repo tidak valid: folder 'skills' tidak berisi skill apa pun.`);
    }

    const invalidNames = skillNames.filter(name => !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name));
    if (invalidNames.length > 0) {
        throw new Error(`Struktur repo tidak valid: nama folder skill harus huruf kecil dengan tanda hubung (contoh: review-code-star), tidak valid: ${invalidNames.join(', ')}`);
    }

    const missingSkillMd = skillNames.filter(name => {
        const files = fs.readdirSync(path.join(sourceSkillsPath, name), { withFileTypes: true })
            .filter(f => f.isFile())
            .map(f => f.name);
        return !files.includes('SKILL.md');
    });
    if (missingSkillMd.length > 0) {
        throw new Error(`Struktur repo tidak valid: file 'SKILL.md' (huruf besar-kecil harus persis) tidak ditemukan di skill: ${missingSkillMd.join(', ')}`);
    }

    return skillNames;
}

// Catatan instalasi per agent dan skill, dipakai oleh `skill list` dan `skill update`
const REGISTRY_FILE = path.join(HOME_DIR, '.aicha', 'installs.json');

function loadRegistry() {
    if (!fs.existsSync(REGISTRY_FILE)) return {};
    return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
}

function saveRegistry(registry) {
    fs.mkdirSync(path.dirname(REGISTRY_FILE), { recursive: true });
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 4), 'utf8');
}

function recordInstall(agent, skill, repository, ref, commit) {
    const registry = loadRegistry();
    registry[`${agent}/${skill}`] = { agent, skill, repository, ref, commit, installedAt: new Date().toISOString() };
    saveRegistry(registry);
}

function hasPat() {
    return config.PAT && config.PAT.trim() !== '' && config.PAT !== 'TEMPEL_TOKEN_PAT_DISINI';
}

// Pastikan token PAT tidak ikut tercetak ke terminal saat terjadi error
function redact(message) {
    return hasPat() ? message.split(config.PAT).join('***') : message;
}

function buildCloneUrl(repository) {
    let url = repository.startsWith('http')
        ? repository
        : `${config.SERVER_URL.replace(/\/$/, '')}/${repository.replace(/^\//, '')}`;

    // Pastikan akhiran .git ada demi keandalan perintah clone
    if (!url.endsWith('.git') && !url.includes('_git')) {
        url += '.git';
    }

    // PAT dikirim sebagai password (username kosong) agar berlaku untuk GitHub, TFS, maupun Azure DevOps
    if (hasPat()) {
        url = url.replace(/^(https?:\/\/)/, `$1:${config.PAT}@`);
    }
    return url;
}

function cleanupTemp(tempPath) {
    if (fs.existsSync(tempPath)) {
        fs.rmSync(tempPath, { recursive: true, force: true });
    }
}

// Clone repo ke folder temporary dan mengembalikan path-nya beserta commit SHA
function cloneRepo(repository, ref) {
    const tempPath = path.join(os.tmpdir(), `aicha-clone-${Date.now()}`);
    try {
        // Saat memakai PAT, kirim Basic auth dari URL dan abaikan login Windows/credential helper yang tersimpan
        const authOptions = hasPat() ? '-c http.proactiveAuth=basic -c credential.helper= ' : '';
        // Nonaktifkan prompt kredensial agar kegagalan autentikasi langsung menjadi error, bukan dialog
        execSync(`git ${authOptions}clone --depth 1 --branch ${ref} "${buildCloneUrl(repository)}" "${tempPath}"`, {
            stdio: 'ignore',
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
        });
        const commit = execSync('git rev-parse HEAD', { cwd: tempPath, encoding: 'utf8' }).trim();
        return { tempPath, commit };
    } catch (error) {
        cleanupTemp(tempPath);
        throw new Error(redact(error.message));
    }
}

function installSkill(agent, skill, sourceDir) {
    const targetDir = path.join(AGENT_TARGETS[agent].dir, skill);
    if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true, force: true });
    fs.mkdirSync(targetDir, { recursive: true });
    fs.cpSync(sourceDir, targetDir, { recursive: true });
}

program
  .name('aicha')
  .description('AICHA - Single Mode Agent Skills Sync Tool')
  .version('2.0.0');

const skillCommand = program
  .command('skill')
  .description('Kelola skill AI');

skillCommand
  .command('install [repository] [skillAndVersion]')
  .description('Unduh dan pasang skill berdasarkan parameter SERVER_URL dan PAT tunggal')
  .option('-r, --ref <versi>', 'tag atau branch yang akan di-install (default: main)')
  .action(async (repository, skillAndVersion, options) => {
    
    let targetSkill = null;
    let targetVersion = options.ref ?? 'main'; 
    
    if (skillAndVersion) {
        if (skillAndVersion.includes('@')) {
            const at = skillAndVersion.indexOf('@');
            targetSkill = skillAndVersion.slice(0, at);
            targetVersion = skillAndVersion.slice(at + 1);
        } else {
            targetSkill = skillAndVersion;
        }
    }

    console.log(`\x1b[36m[AICHA]\x1b[0m Menghubungkan ke remote target...`);

    let tempExtractPath = null;

    try {
        // 1. Pastikan konfigurasi dan repository tersedia, lalu clone ke folder temporary
        await loadConfig();
        if (!repository) {
            repository = await input({
                message: 'Masukkan repository (contoh: erwinant/ai-skills-libs)',
                validate: value => value.trim() !== '' || 'Repository wajib diisi',
            });
            repository = repository.trim();
        }
        const repo = cloneRepo(repository, targetVersion);
        tempExtractPath = repo.tempPath;

        // 2. Validasi struktur repo lalu tentukan skill yang mau disalin
        const availableSkills = validateSkillStructure(tempExtractPath);

        let skillsToInstall = [];
        if (targetSkill) {
            if (!availableSkills.includes(targetSkill)) {
                throw new Error(`Skill "${targetSkill}" tidak ditemukan di repositori.`);
            }
            skillsToInstall.push(targetSkill);
        } else {
            skillsToInstall = await checkbox({
                message: 'Pilih skill yang mau di-install',
                choices: availableSkills.map(name => ({ name, value: name })),
                required: true,
            });
        }

        // 3. Tentukan agent tujuan instalasi
        const agentsToInstall = await checkbox({
            message: 'Pilih agent tujuan instalasi',
            choices: Object.entries(AGENT_TARGETS).map(([value, { label }]) => ({ name: label, value })),
            required: true,
        });

        // 4. Salin skill yang dipilih ke folder setiap agent dan catat instalasinya
        for (const agent of agentsToInstall) {
            for (const skill of skillsToInstall) {
                installSkill(agent, skill, path.join(tempExtractPath, 'skills', skill));
                recordInstall(agent, skill, repository, targetVersion, repo.commit);
                console.log(`\x1b[32m✔\x1b[0m [${AGENT_TARGETS[agent].label}] Berhasil memuat skill: \x1b[1m${skill}\x1b[0m (${targetVersion})`);
            }
        }

        console.log(`\n\x1b[32m✔ [SUKSES SINKRONISASI] File SKILL.md telah disalin ke folder internal aplikasi.\x1b[0m`);

    } catch (error) {
        if (error.name === 'ExitPromptError') {
            console.log(`\x1b[33m[AICHA]\x1b[0m Instalasi dibatalkan.`);
        } else {
            console.error(`\x1b[31m✖ [AICHA GAGAL]:\x1b[0m`, error.message);
        }
    } finally {
        if (tempExtractPath) cleanupTemp(tempExtractPath);
    }
  });

skillCommand
  .command('list')
  .description('Tampilkan skill yang terpasang beserta versi (ref dan commit)')
  .action(() => {
    const entries = Object.values(loadRegistry());
    if (entries.length === 0) {
        console.log('[AICHA] Belum ada skill yang terpasang melalui aicha.');
        return;
    }
    entries.sort((a, b) => a.agent.localeCompare(b.agent) || a.skill.localeCompare(b.skill));
    console.table(entries.map(e => ({
        Agent: AGENT_TARGETS[e.agent]?.label ?? e.agent,
        Skill: e.skill,
        Repository: e.repository,
        Versi: e.ref,
        Commit: e.commit.slice(0, 7),
        'Terpasang pada': e.installedAt,
    })));
  });

skillCommand
  .command('update [skill]')
  .description('Perbarui skill yang terpasang ke versi (ref) terbaru dari repository asalnya')
  .action(async (skill) => {
    let entries = Object.values(loadRegistry());
    if (skill) entries = entries.filter(e => e.skill === skill);
    if (entries.length === 0) {
        console.log(skill
            ? `[AICHA] Skill "${skill}" tidak terpasang melalui aicha.`
            : '[AICHA] Tidak ada skill terpasang untuk diperbarui.');
        return;
    }

    try {
        await loadConfig();
    } catch (error) {
        if (error.name === 'ExitPromptError') {
            console.log(`\x1b[33m[AICHA]\x1b[0m Pembaruan dibatalkan.`);
        } else {
            console.error(`\x1b[31m✖ [AICHA GAGAL]:\x1b[0m`, error.message);
        }
        return;
    }

    // Kelompokkan per repository + ref agar setiap repository hanya di-clone sekali
    const groups = new Map();
    for (const entry of entries) {
        const key = `${entry.repository}@@${entry.ref}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(entry);
    }

    for (const group of groups.values()) {
        const { repository, ref } = group[0];
        let tempExtractPath = null;
        try {
            console.log(`\x1b[36m[AICHA]\x1b[0m Memeriksa ${repository} (${ref})...`);
            const repo = cloneRepo(repository, ref);
            tempExtractPath = repo.tempPath;
            const availableSkills = validateSkillStructure(tempExtractPath);

            for (const entry of group) {
                if (!availableSkills.includes(entry.skill)) {
                    console.log(`\x1b[33m⚠\x1b[0m ${entry.skill} tidak ada lagi di ${repository} (${ref}), dilewati.`);
                    continue;
                }
                if (entry.commit === repo.commit) {
                    console.log(`\x1b[32m✔\x1b[0m [${AGENT_TARGETS[entry.agent].label}] ${entry.skill} sudah terbaru (${repo.commit.slice(0, 7)}).`);
                    continue;
                }
                installSkill(entry.agent, entry.skill, path.join(tempExtractPath, 'skills', entry.skill));
                recordInstall(entry.agent, entry.skill, repository, ref, repo.commit);
                console.log(`\x1b[32m✔\x1b[0m [${AGENT_TARGETS[entry.agent].label}] ${entry.skill} diperbarui: ${entry.commit.slice(0, 7)} → ${repo.commit.slice(0, 7)}`);
            }
        } catch (error) {
            console.error(`\x1b[31m✖ [AICHA GAGAL]:\x1b[0m`, error.message);
        } finally {
            if (tempExtractPath) cleanupTemp(tempExtractPath);
        }
    }
  });

program.parse(process.argv);
