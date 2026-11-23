/**
 * Caminho authenticated → ready (_injectUtilsAndEmitReady), sem navegador:
 * o `this` é um Client falso com a página simulada. Roda sem sessão do
 * WhatsApp: `npx mocha tests/ready-retry.js`.
 */
const { expect } = require('chai');
const Client = require('../src/Client');
const { Events } = require('../src/util/Constants');
const { LoadUtils } = require('../src/util/Injected/Utils');

function fakeClient({
    failures = {},
    injected = false,
    reloadOnInfoFail = false,
} = {}) {
    const calls = { evaluate: 0, loadUtils: 0, wait: 0, info: 0, attach: 0 };
    const emitted = [];
    const counters = { ...failures };
    const pageState = { wwebjs: injected };
    const fail = (step) => {
        if (counters[step] > 0) {
            counters[step] -= 1;
            throw new Error(`falha simulada em ${step}`);
        }
    };
    const page = {
        isClosed: () => false,
        evaluate: async (fn) => {
            calls.evaluate += 1;
            if (fn === LoadUtils) {
                calls.loadUtils += 1;
                fail('load_utils');
                pageState.wwebjs = true;
                return undefined;
            }
            const src = String(fn);
            if (src.includes('WAWebConnModel')) {
                calls.info += 1;
                if (reloadOnInfoFail && counters.client_info > 0) {
                    pageState.wwebjs = false; // a página recarregou
                }
                fail('client_info');
                return { wid: { _serialized: 'eu@c.us' }, pushname: 'Teste' };
            }
            return pageState.wwebjs; // typeof window.WWebJS !== 'undefined'
        },
        waitForFunction: async () => {
            calls.wait += 1;
            fail('wait_utils');
        },
    };
    const client = Object.create(Client.prototype);
    Object.assign(client, {
        pupPage: page,
        options: {
            webVersionCache: { type: 'none' },
            readyRetryDelaysMs: [1, 1, 1],
        },
        authStrategy: { afterAuthReady: () => emitted.push('afterAuthReady') },
        attachEventListeners: async () => {
            calls.attach += 1;
            fail('attach_listeners');
        },
        emit: (event, info) => {
            emitted.push(info ? `${event}:${info.step}` : event);
            return true;
        },
    });
    return { client, calls, emitted };
}

describe('Client._injectUtilsAndEmitReady', function () {
    let warn;

    beforeEach(function () {
        warn = console.warn;
        console.warn = () => {};
    });

    afterEach(function () {
        console.warn = warn;
    });

    it('sem falha: injeta, liga os listeners uma vez e emite READY', async function () {
        const { client, calls, emitted } = fakeClient();
        await client._injectUtilsAndEmitReady('2.3000.1');
        expect(calls.loadUtils).to.equal(1);
        expect(calls.attach).to.equal(1);
        expect(emitted).to.deep.equal([Events.READY, 'afterAuthReady']);
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
            'afterAuthReady',
        ]);
    });

    it('falha no client_info não repete o load_utils já feito', async function () {
        const { client, calls, emitted } = fakeClient({
            failures: { client_info: 1 },
        });
        await client._injectUtilsAndEmitReady('2.3000.1');
        expect(calls.loadUtils).to.equal(1);
        expect(calls.info).to.equal(2);
        expect(calls.attach).to.equal(1);
        expect(emitted[emitted.length - 2]).to.equal(Events.READY);
    });

    it('falha no attach_listeners não repete (evita listener duplicado) e não emite READY', async function () {
        const { client, calls, emitted } = fakeClient({
            failures: { attach_listeners: 1 },
        });
        let err;
        try {
            await client._injectUtilsAndEmitReady('2.3000.1');
        } catch (e) {
            err = e;
        }
        expect(err).to.be.instanceOf(Error);
        expect(err.readyInfo.step).to.equal('attach_listeners');
        expect(calls.attach).to.equal(1);
        expect(emitted).to.not.include(Events.READY);
    });

    it('esgotadas as tentativas: lança com o passo e não emite READY', async function () {
        const { client, emitted } = fakeClient({
            failures: { wait_utils: 10 },
        });
        let err;
        try {
            await client._injectUtilsAndEmitReady('2.3000.1');
        } catch (e) {
            err = e;
        }
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

    it('página recarregou entre tentativas: injeta os utilitários de novo', async function () {
        const { client, calls, emitted } = fakeClient({
            failures: { client_info: 1 },
            reloadOnInfoFail: true,
        });
        await client._injectUtilsAndEmitReady('2.3000.1');
        expect(calls.loadUtils).to.equal(2);
        expect(calls.attach).to.equal(1);
        expect(emitted[emitted.length - 2]).to.equal(Events.READY);
    });

    it('página já injetada (reconexão): só emite READY, sem religar listeners', async function () {
        const { client, calls, emitted } = fakeClient({ injected: true });
        await client._injectUtilsAndEmitReady('2.3000.1');
        expect(calls.loadUtils).to.equal(0);
        expect(calls.attach).to.equal(0);
        expect(emitted).to.deep.equal([Events.READY, 'afterAuthReady']);
    });
});
