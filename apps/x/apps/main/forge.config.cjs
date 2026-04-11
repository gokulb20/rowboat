// Electron Forge config file
// NOTE: Must be .cjs (CommonJS) because package.json has "type": "module"
// Forge loads configs with require(), which fails on ESM files

const path = require('path');
const pkg = require('./package.json');

// Gate code signing on the presence of Apple credentials so local dev
// builds (unsigned) still package successfully. Upstream forge.config.cjs
// treated osxSign/osxNotarize as unconditional, which fails without
// APPLE_ID/APPLE_PASSWORD/APPLE_TEAM_ID in the env. For Crewm8 Desktop
// gateway builds we ship unsigned locally and only sign in CI.
const hasAppleCreds = !!(process.env.APPLE_ID && process.env.APPLE_PASSWORD && process.env.APPLE_TEAM_ID);

module.exports = {
    packagerConfig: {
        // Crewm8 Desktop Gateway — rebranded from upstream Rowboat 2026-04-11.
        // NOTE: appBundleId stays 'com.rowboat.app' intentionally so macOS TCC
        // permissions (Screen Recording, Microphone, etc.) continue to apply
        // to the same bundle. Changing the bundle id would force the user to
        // re-grant every privacy permission. Accept the minor inconsistency
        // (TCC shows 'Crewm8' via CFBundleName but the underlying identifier
        // is still com.rowboat.app) for the UX benefit.
        name: 'Crewm8',
        executableName: 'crewm8',
        icon: './icons/icon',  // .icns extension added automatically
        appBundleId: 'com.rowboat.app',
        appCategoryType: 'public.app-category.productivity',
        extendInfo: {
            NSAudioCaptureUsageDescription: 'Crewm8 needs access to system audio to transcribe meetings from other apps (Zoom, Meet, etc.)',
        },
        ...(hasAppleCreds ? {
            osxSign: {
                batchCodesignCalls: true,
                optionsForFile: () => ({
                    entitlements: path.join(__dirname, 'entitlements.plist'),
                    'entitlements-inherit': path.join(__dirname, 'entitlements.plist'),
                }),
            },
            osxNotarize: {
                appleId: process.env.APPLE_ID,
                appleIdPassword: process.env.APPLE_PASSWORD,
                teamId: process.env.APPLE_TEAM_ID
            },
        } : {}),
        // Since we bundle everything with esbuild, we don't need node_modules at all.
        // These settings prevent Forge's dependency walker (flora-colossus) from trying
        // to analyze/copy node_modules, which fails with pnpm's symlinked workspaces.
        prune: false,
        ignore: [
            /src\//,
            /node_modules\//,
            /.gitignore/,
            /bundle\.mjs/,
            /tsconfig.json/,
        ],
    },
    makers: [
        {
            name: '@electron-forge/maker-dmg',
            config: (arch) => ({
                format: 'ULFO',
                name: `Crewm8-darwin-${arch}-${pkg.version}`,
            })
        },
        {
            name: '@electron-forge/maker-squirrel',
            config: (arch) => ({
                authors: 'Useful Ventures',
                description: 'Crewm8 Desktop Gateway',
                name: `Crewm8-win32-${arch}`,
                setupExe: `Crewm8-win32-${arch}-${pkg.version}-setup.exe`,
            })
        },
        {
            name: '@electron-forge/maker-deb',
            config: () => ({
                options: {
                    name: `Crewm8-linux`,
                    bin: "crewm8",
                    description: 'Crewm8 Desktop Gateway',
                    maintainer: 'Useful Ventures',
                    homepage: 'https://crewm8.ai'
                }
            })
        },
        {
            name: '@electron-forge/maker-rpm',
            config: {
                options: {
                    name: `Crewm8-linux`,
                    bin: "crewm8",
                    description: 'Crewm8 Desktop Gateway',
                    homepage: 'https://crewm8.ai'
                }
            }
        },
        {
            name: '@electron-forge/maker-zip',
            platform: ["darwin", "win32", "linux"],
        }
    ],
    // Publishers removed — custom Crewm8 builds are installed locally, not
    // published to GitHub releases. The upstream rowboatlabs/rowboat publisher
    // entry was deleted here to prevent accidental re-release to their repo.
    publishers: [],
    hooks: {
        // Hook signature: (forgeConfig, platform, arch)
        // Note: Console output only shows if DEBUG or CI env vars are set
        generateAssets: async (forgeConfig, platform, arch) => {
            const { execSync } = require('child_process');
            const fs = require('fs');

            const packageDir = path.join(__dirname, '.package');

            // Clean staging directory (ensures fresh build every time)
            console.log('Cleaning staging directory...');
            if (fs.existsSync(packageDir)) {
                fs.rmSync(packageDir, { recursive: true });
            }
            fs.mkdirSync(packageDir, { recursive: true });

            // Build order matters! Dependencies must be built before dependents:
            // shared → core → (renderer, preload, main)

            // Build shared (TypeScript compilation) - no dependencies
            console.log('Building shared...');
            execSync('pnpm run build', {
                cwd: path.join(__dirname, '../../packages/shared'),
                stdio: 'inherit'
            });

            // Build core (TypeScript compilation) - depends on shared
            console.log('Building core...');
            execSync('pnpm run build', {
                cwd: path.join(__dirname, '../../packages/core'),
                stdio: 'inherit'
            });

            // Build renderer (Vite build) - depends on shared
            console.log('Building renderer...');
            execSync('pnpm run build', {
                cwd: path.join(__dirname, '../renderer'),
                stdio: 'inherit'
            });

            // Build preload (TypeScript compilation) - depends on shared
            console.log('Building preload...');
            execSync('pnpm run build', {
                cwd: path.join(__dirname, '../preload'),
                stdio: 'inherit'
            });

            // Build main (TypeScript compilation) - depends on core, shared
            console.log('Building main (tsc)...');
            execSync('pnpm run build', {
                cwd: __dirname,
                stdio: 'inherit'
            });

            // Bundle main process with esbuild (inlines all dependencies)
            console.log('Bundling main process...');
            execSync('node bundle.mjs', {
                cwd: __dirname,
                stdio: 'inherit'
            });

            // Copy preload dist into staging directory
            console.log('Copying preload...');
            const preloadSrc = path.join(__dirname, '../preload/dist');
            const preloadDest = path.join(packageDir, 'preload/dist');
            fs.mkdirSync(preloadDest, { recursive: true });
            fs.cpSync(preloadSrc, preloadDest, { recursive: true });

            // Copy renderer dist into staging directory
            console.log('Copying renderer...');
            const rendererSrc = path.join(__dirname, '../renderer/dist');
            const rendererDest = path.join(packageDir, 'renderer/dist');
            fs.mkdirSync(rendererDest, { recursive: true });
            fs.cpSync(rendererSrc, rendererDest, { recursive: true });

            console.log('✅ All assets staged in .package/');
        },
    }
};