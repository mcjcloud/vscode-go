/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 * Modification copyright 2020 The Go Authors. All rights reserved.
 * Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------*/

import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs-extra';
import { describe, it } from 'mocha';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import * as util from 'util';
import * as vscode from 'vscode';

import {
	disposeGoStatusBar,
	formatGoVersion,
	getGoEnvironmentStatusbarItem,
	getSelectedGo,
	GoEnvironmentOption,
	setSelectedGo,
} from '../../src/goEnvironmentStatus';
import { updateGoVarsFromConfig } from '../../src/goInstallTools';
import ourutil = require('../../src/util');
import { getCurrentGoRoot } from '../../src/utils/goPath';

describe('#initGoStatusBar()', function () {
	this.beforeAll(async () => {
		await updateGoVarsFromConfig();  // should initialize the status bar.
	});

	this.afterAll(() => {
		disposeGoStatusBar();
	});

	it('should create a status bar item', () => {
		assert.notEqual(getGoEnvironmentStatusbarItem(), undefined);
	});

	it('should create a status bar item with a label matching go.goroot version', async () => {
		const version = await ourutil.getGoVersion();
		const versionLabel = formatGoVersion(version.format());
		assert.equal(
			getGoEnvironmentStatusbarItem().text,
			versionLabel,
			'goroot version does not match status bar item text'
		);
	});
});

describe('#setSelectedGo()', function () {
	// Disabled due to https://github.com/golang/vscode-go/issues/303.
	this.timeout(40000);
	let sandbox: sinon.SinonSandbox | undefined;
	let goOption: GoEnvironmentOption;
	let defaultGoConfig: vscode.WorkspaceConfiguration;

	this.beforeAll(async () => {
		defaultGoConfig = ourutil.getGoConfig();
	});

	this.beforeEach(async () => {
		goOption = await getSelectedGo();
		console.log('get goOption: ', JSON.stringify(goOption));
		sandbox = sinon.createSandbox();
	});
	this.afterEach(async () => {
		console.log('set goOption: ', JSON.stringify(goOption));
		await setSelectedGo(goOption, vscode.ConfigurationTarget.Workspace, false);
		sandbox.restore();
	});

	it('should update the workspace settings.json', async () => {
		let tmpAltToolsWorkspace: any = {};
		let tmpAltToolsGlobal: any = {};
		const getGoConfigStub = sandbox.stub(ourutil, 'getGoConfig').returns({
			get: (s: string) => {
				if (s === 'alternateTools') { return tmpAltToolsWorkspace || tmpAltToolsGlobal; }
				return defaultGoConfig.get(s);
			},
			update: (key: string, value: any, scope: vscode.ConfigurationTarget) => {
				if (key === 'alternateTools') {
					if (scope === vscode.ConfigurationTarget.Global) {
						tmpAltToolsGlobal = value;
					} else {
						tmpAltToolsWorkspace = value;
					}
				}
			},
		} as vscode.WorkspaceConfiguration);

		// set workspace setting
		const workspaceTestOption = new GoEnvironmentOption('workspacetestpath', 'testlabel');
		await setSelectedGo(workspaceTestOption, vscode.ConfigurationTarget.Workspace, false);

		// check that the stub was called
		sandbox.assert.calledWith(getGoConfigStub);

		// check that the new config is set
		assert.equal(tmpAltToolsWorkspace['go'], 'workspacetestpath');
	});

	it('should download an uninstalled version of Go', async () => {
		if (!process.env['VSCODEGO_BEFORE_RELEASE_TESTS']) {
			return;
		}

		let tmpAltToolsWorkspace = {};
		let tmpAltToolsGlobal = {};
		const getGoConfigStub = sandbox.stub(ourutil, 'getGoConfig').returns({
			get: (s: string) => {
				if (s === 'alternateTools') { return tmpAltToolsWorkspace || tmpAltToolsGlobal; }
				return defaultGoConfig.get(s);
			},
			update: (key: string, value: any, scope: vscode.ConfigurationTarget) => {
				if (key === 'alternateTools') {
					if (scope === vscode.ConfigurationTarget.Global) {
						tmpAltToolsGlobal = value;
					} else {
						tmpAltToolsWorkspace = value;
					}
				}
			},
		} as vscode.WorkspaceConfiguration);

		// setup tmp home directory for sdk installation
		const envCache = Object.assign({}, process.env);
		process.env.HOME = os.tmpdir();

		// set selected go as a version to download
		const option = new GoEnvironmentOption('go get golang.org/dl/go1.13.12', 'Go 1.13.12');
		await setSelectedGo(option, vscode.ConfigurationTarget.Workspace, false);
		sandbox.assert.calledWith(getGoConfigStub);

		// the temp sdk directory should now contain go1.13.12
		const subdirs = await fs.readdir(path.join(os.tmpdir(), 'sdk'));
		assert.ok(subdirs.includes('go1.13.12'), 'Go 1.13.12 was not installed');

		// cleanup
		process.env = envCache;
	});
});

describe('#updateGoVarsFromConfig()', function () {
	this.timeout(10000);

	let defaultGoConfig: vscode.WorkspaceConfiguration | undefined;
	let tmpRoot: string | undefined;
	let tmpRootBin: string | undefined;
	let sandbox: sinon.SinonSandbox | undefined;

	this.beforeAll(async () => {
		defaultGoConfig = ourutil.getGoConfig();

		tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rootchangetest'));
		tmpRootBin = path.join(tmpRoot, 'bin');

		// build a fake go binary and place it in tmpRootBin.
		fs.mkdirSync(tmpRootBin);

		const fixtureSourcePath = path.join(__dirname, '..', '..', '..', 'test', 'fixtures', 'testhelpers');
		const execFile = util.promisify(cp.execFile);
		const goRuntimePath = ourutil.getBinPath('go');
		const { stdout, stderr } = await execFile(
			goRuntimePath, ['build', '-o', path.join(tmpRootBin, 'go'), path.join(fixtureSourcePath, 'fakego.go')]);
		if (stderr) {
			assert.fail(`failed to build the fake go binary required for testing: ${stderr}`);
		}
	});

	this.afterAll(async () => {
		ourutil.rmdirRecursive(tmpRoot);
		await updateGoVarsFromConfig();
	});

	this.beforeEach(() => {
		sandbox = sinon.createSandbox();
	});

	this.afterEach(() => {
		sandbox.restore();
	});

	function pathEnvVar(): string[] {
		let paths = [] as string[];
		if (process.env.hasOwnProperty('PATH')) {
			paths = process.env['PATH'].split(path.delimiter);
		} else if (process.platform === 'win32' && process.env.hasOwnProperty('Path')) {
			paths = process.env['Path'].split(path.delimiter);
		}
		return paths;
	}

	it('should have a sensible goroot with the default setting', async () => {
		await updateGoVarsFromConfig();

		const b = getGoEnvironmentStatusbarItem();
		assert.ok(b.text.startsWith('Go'), `go env statusbar item = ${b.text}, want "Go..."`);
		assert.equal(pathEnvVar()[0], [path.join(getCurrentGoRoot(), 'bin')],
			`the first element in PATH must match the current GOROOT/bin`);
	});

	it('should recognize the adjusted goroot using go.goroot', async () => {
		// stub geteGoConfig to return "go.goroot": tmpRoot.
		const getGoConfigStub = sandbox.stub(ourutil, 'getGoConfig').returns({
			get: (s: string) => {
				if (s === 'goroot') { return tmpRoot; }
				return defaultGoConfig.get(s);
			},
		} as vscode.WorkspaceConfiguration);

		// adjust the fake go binary's behavior.
		process.env['FAKEGOROOT'] = tmpRoot;
		process.env['FAKEGOVERSION'] = 'go version go2.0.0 darwin/amd64';

		await updateGoVarsFromConfig();

		sandbox.assert.calledWith(getGoConfigStub);
		assert.equal((await ourutil.getGoVersion()).format(), '2.0.0');
		assert.equal(getGoEnvironmentStatusbarItem().text, 'Go 2.0.0');
		assert.equal(pathEnvVar()[0], [path.join(getCurrentGoRoot(), 'bin')],
			`the first element in PATH must match the current GOROOT/bin`);
	});

	it('should recognize the adjusted goroot using go.alternateTools', async () => {
		// "go.alternateTools" : {"go": "go3"}
		fs.copyFileSync(path.join(tmpRootBin, 'go'), path.join(tmpRootBin, 'go3'));

		const getGoConfigStub = sandbox.stub(ourutil, 'getGoConfig').returns({
			get: (s: string) => {
				if (s === 'alternateTools') {
					return { go: path.join(tmpRootBin, 'go3') };
				}
				return defaultGoConfig.get(s);
			},
		} as vscode.WorkspaceConfiguration);

		process.env['FAKEGOROOT'] = tmpRoot;
		process.env['FAKEGOVERSION'] = 'go version go3.0.0 darwin/amd64';

		await updateGoVarsFromConfig();

		sandbox.assert.calledWith(getGoConfigStub);
		assert.equal((await ourutil.getGoVersion()).format(), '3.0.0');
		assert.equal(getGoEnvironmentStatusbarItem().text, 'Go 3.0.0');
		assert.equal(pathEnvVar()[0], [path.join(getCurrentGoRoot(), 'bin')],
			`the first element in PATH must match the current GOROOT/bin`);
	});
});
