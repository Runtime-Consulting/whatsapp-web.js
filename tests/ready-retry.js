/**
 * Caminho authenticated → ready (_onAppStateHasSynced /
 * _injectUtilsAndEmitReady), sem navegador: o `this` é um Client falso com a
 * página simulada. Roda sem sessão do WhatsApp: `npx mocha tests/ready-retry.js`.
 */
const { expect } = require('chai');
const sinon = require('sinon');
const Client = require('../src/Client');
const WebCacheFactory = require('../src/webCache/WebCacheFactory');
const { Events } = require('../src/util/Constants');
const { LoadUtils } = require('../src/util/Injected/Utils');

function fakeClient({
    failures = {},
    attached = false,
    attachStarted = false,
    hang = {},
    reloadOnInfoFail = false,
    options = {},
    readyListenerThrows = false,
    failMessages = {},
    browserConnected = true,
} = {}) {
    const calls = {
        loadUtils: 0,
        wait: 0,
        info: 0,
        attach: 0,
        afterAuthReady: 0,
    };
    const emitted = [];
    const counters = { ...failures };
    const hangs = { ...hang };
    const page = {
        doc: 1,
        utils: attached,
        attached,
        attachStarted,
        closed: false,
    };
    const fail = (step) => {
        if (counters[step] > 0) {
            counters[step] -= 1;
            throw new Error(failMessages[step] || `falha simulada em ${step}`);
        }
    };
    const maybeHang = (step) => {
        if (hangs[step] > 0) {
            hangs[step] -= 1;
            return new Promise(() => {});
        }
        return null;
    };

    const pupPage = {
        isClosed: () => page.closed,
        evaluate: async (fn) => {
            if (fn === LoadUtils) {
                calls.loadUtils += 1;
                fail('load_utils');
                page.utils = true;
                return undefined;
            }
            const src = String(fn);
            if (src.includes('performance.timeOrigin')) {
                return {
                    doc: page.doc,
                    attached: page.attached,
                    attachStarted: page.attachStarted,
                    utils: page.utils,
                };
            }
            if (src.includes('WAWebConnModel')) {
                calls.info += 1;
                const h = maybeHang('client_info');
                if (h) return h;
                if (reloadOnInfoFail && counters.client_info > 0) {
                    page.doc += 1; // a página recarregou
                    page.utils = false;
                }
                fail('client_info');
                return { wid: { _serialized: 'eu@c.us' }, pushname: 'Teste' };
            }
            if (src.includes('__wwebjsAttachStarted = true')) {
                page.attachStarted = true;
                return undefined;
            }
            if (src.includes('__wwebjsAttached = true')) {
                page.attached = true;
                return undefined;
            }
            throw new Error(`evaluate inesperado: ${src.slice(0, 80)}`);
        },
        waitForFunction: async () => {
            calls.wait += 1;
            fail('wait_utils');
        },
    };

    const client = Object.create(Client.prototype);
    Object.assign(client, {
        pupPage,
        pupBrowser: { isConnected: () => browserConnected },
        options: {
            webVersionCache: { type: 'none' },
            readyRetryDelaysMs: [1, 1, 1],
            readyStepTimeoutMs: 30,
            ...options,
        },
        authStrategy: {
            getAuthEventPayload: async () => undefined,
            afterAuthReady: () => {
                calls.afterAuthReady += 1;
            },
        },
        attachEventListeners: async () => {
            calls.attach += 1;
            fail('attach_listeners');
        },
        emit: (event, info) => {
            emitted.push(info && info.step ? `${event}:${info.step}` : event);
            if (event === Events.READY && readyListenerThrows) {
                throw new Error('listener de ready quebrado');
            }
            return true;
        },
    });
    return { client, calls, emitted, page };
}

async function catchError(promise) {
    try {
        await promise;
    } catch (e) {
        return e;
    }
    return null;
}

describe('Client: caminho authenticated → ready', function () {
    let warn;

    beforeEach(function () {
        warn = console.warn;
        console.warn = () => {};
    });

    afterEach(function () {
        console.warn = warn;
        sinon.restore();
    });

    it('sem falha: injeta, liga os listeners uma vez, marca a página e emite READY', async function () {
        const { client, calls, emitted, page } = fakeClient();
        expect(await client._injectUtilsAndEmitReady('2.3000.1')).to.equal(
            true,
        );
        expect(calls.loadUtils).to.equal(1);
        expect(calls.attach).to.equal(1);
        expect(page.attached).to.equal(true);
        expect(emitted).to.deep.equal([Events.READY]);
        expect(calls.afterAuthReady).to.equal(1);
    });

    it('falha passageira no load_utils: tenta de novo na mesma página e emite READY', async function () {
        const { client, calls, emitted } = fakeClient({
            failures: { load_utils: 2 },
        });
        await client._injectUtilsAndEmitReady('2.3000.1');
        expect(calls.loadUtils).to.equal(3);
        expect(calls.attach).to.equal(1);
        expect(emitted).to.deep.equal([
            `${Events.READY_RETRY}:load_utils`,
            `${Events.READY_RETRY}:load_utils`,
            Events.READY,
        ]);
    });

    it('falha no client_info não repete o load_utils já feito', async function () {
        const { client, calls, emitted } = fakeClient({
            failures: { client_info: 1 },
        });
        await client._injectUtilsAndEmitReady('2.3000.1');
        expect(calls.loadUtils).to.equal(1);
        expect(calls.info).to.equal(2);
        expect(emitted[emitted.length - 1]).to.equal(Events.READY);
    });

    it('passo que pendura estoura o prazo e é repetido (antes ficava 120 s em silêncio)', async function () {
        const { client, calls, emitted } = fakeClient({
            hang: { client_info: 1 },
        });
        await client._injectUtilsAndEmitReady('2.3000.1');
        expect(calls.info).to.equal(2);
        expect(emitted).to.deep.equal([
            `${Events.READY_RETRY}:client_info`,
            Events.READY,
        ]);
    });

    it('falha no attach_listeners: não repete (evita listener duplicado) e não emite READY', async function () {
        const { client, calls, emitted } = fakeClient({
            failures: { attach_listeners: 1 },
        });
        const err = await catchError(
            client._injectUtilsAndEmitReady('2.3000.1'),
        );
        expect(err.readyInfo.step).to.equal('attach_listeners');
        expect(calls.attach).to.equal(1);
        expect(emitted).to.not.include(Events.READY);
    });

    it('listeners ligados pela metade neste documento: desiste sem religar', async function () {
        const { client, calls } = fakeClient({ attachStarted: true });
        const err = await catchError(
            client._injectUtilsAndEmitReady('2.3000.1'),
        );
        expect(err.readyInfo.step).to.equal('attach_incomplete');
        expect(calls.attach).to.equal(0);
    });

    it('esgotadas as tentativas: lança com o passo e não emite READY', async function () {
        const { client, emitted } = fakeClient({
            failures: { wait_utils: 10 },
        });
        const err = await catchError(
            client._injectUtilsAndEmitReady('2.3000.1'),
        );
        expect(err.readyInfo).to.include({
            step: 'wait_utils',
            attempt: 4,
            attempts: 4,
        });
        expect(
            emitted.filter((e) => e.startsWith(Events.READY_RETRY)),
        ).to.have.length(3);
        expect(emitted).to.not.include(Events.READY);
    });

    it('página recarregou entre tentativas: abandona sem READY (o inject() da página nova assume)', async function () {
        const { client, calls, emitted } = fakeClient({
            failures: { client_info: 1 },
            reloadOnInfoFail: true,
        });
        expect(await client._injectUtilsAndEmitReady('2.3000.1')).to.equal(
            false,
        );
        expect(calls.attach).to.equal(0);
        expect(emitted).to.not.include(Events.READY);
    });

    it('página já montada (reconexão): só emite READY, sem religar listeners', async function () {
        const { client, calls, emitted } = fakeClient({ attached: true });
        await client._injectUtilsAndEmitReady('2.3000.1');
        expect(calls.loadUtils).to.equal(0);
        expect(calls.attach).to.equal(0);
        expect(emitted).to.deep.equal([Events.READY]);
    });

    it('cache da versão que falha ao gravar não impede o READY', async function () {
        sinon.stub(WebCacheFactory, 'createWebCache').returns({
            persist: async () => {
                throw new Error('ENOSPC');
            },
        });
        const { client, emitted } = fakeClient({
            options: { webVersionCache: { type: 'local' } },
        });
        client.currentIndexHtml = '<html></html>';
        await client._injectUtilsAndEmitReady('2.3000.1');
        expect(emitted).to.deep.equal([Events.READY]);
    });

    it("listener de 'ready' que lança erro não vira nova tentativa nem ready_failed", async function () {
        const { client, calls, emitted } = fakeClient({
            readyListenerThrows: true,
        });
        expect(await client._injectUtilsAndEmitReady('2.3000.1')).to.equal(
            true,
        );
        expect(emitted).to.deep.equal([Events.READY]);
        expect(calls.attach).to.equal(1);
        expect(calls.afterAuthReady).to.equal(1);
    });

    it('chamada que chega durante outra fica pendente e roda no fim', async function () {
        const { client, emitted } = fakeClient();
        const first = client._onAppStateHasSynced('2.3000.1');
        await client._onAppStateHasSynced('2.3000.1'); // descartada agora, pendente
        await first;
        await new Promise((r) => setTimeout(r, 20)); // roda a pendente
        expect(emitted).to.deep.equal([
            Events.AUTHENTICATED,
            Events.READY,
            Events.AUTHENTICATED,
            Events.READY,
        ]);
    });

    it('erro no caminho vira ready_failed com o passo (não morre em silêncio)', async function () {
        const { client, emitted } = fakeClient({
            failures: { attach_listeners: 1 },
        });
        await client._onAppStateHasSynced('2.3000.1');
        expect(emitted).to.deep.equal([
            Events.AUTHENTICATED,
            `${Events.READY_FAILED}:attach_listeners`,
        ]);
    });

    it('página trocada no attach (Target closed): abandona sem READY_FAILED, o inject() da página nova assume', async function () {
        const { client, calls, emitted } = fakeClient({
            failures: { attach_listeners: 1 },
            failMessages: {
                attach_listeners:
                    'Protocol error (Page.addScriptToEvaluateOnNewDocument): Target closed',
            },
        });
        await client._onAppStateHasSynced('2.3000.1');
        expect(calls.attach).to.equal(1);
        expect(emitted).to.deep.equal([Events.AUTHENTICATED]);
    });

    it('contexto destruído no load_utils (navegação): abandona sem tentar de novo', async function () {
        const { client, calls, emitted } = fakeClient({
            failures: { load_utils: 1 },
            failMessages: {
                load_utils:
                    'Execution context was destroyed, most likely because of a navigation.',
            },
        });
        expect(await client._injectUtilsAndEmitReady('2.3000.1')).to.equal(
            false,
        );
        expect(calls.loadUtils).to.equal(1);
        expect(emitted).to.deep.equal([]);
    });

    it('Target closed com o browser caído: aí sim é ready_failed', async function () {
        const { client, emitted } = fakeClient({
            failures: { attach_listeners: 1 },
            failMessages: { attach_listeners: 'Target closed' },
            browserConnected: false,
        });
        await client._onAppStateHasSynced('2.3000.1');
        expect(emitted).to.deep.equal([
            Events.AUTHENTICATED,
            `${Events.READY_FAILED}:attach_listeners`,
        ]);
    });
});
