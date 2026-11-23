/**
 * exposeFunctionIfAbsent: registro de função na página que pode ser repetido
 * depois de uma falha no meio. Sem navegador: `npx mocha tests/expose-function.js`.
 */
const { expect } = require('chai');
const { exposeFunctionIfAbsent } = require('../src/util/Puppeteer');

describe('exposeFunctionIfAbsent', function () {
    it('binding meio registrado no Puppeteer ("already exists") é refeito', async function () {
        const calls = [];
        let first = true;
        const page = {
            evaluate: async () => false,
            exposeFunction: async (name) => {
                calls.push(`expose:${name}`);
                if (first) {
                    first = false;
                    throw new Error(
                        `Failed to add page binding with name ${name}: window['${name}'] already exists!`,
                    );
                }
            },
            removeExposedFunction: async (name) => {
                calls.push(`remove:${name}`);
            },
        };
        await exposeFunctionIfAbsent(page, 'onAddMessageEvent', () => {});
        expect(calls).to.deep.equal([
            'expose:onAddMessageEvent',
            'remove:onAddMessageEvent',
            'expose:onAddMessageEvent',
        ]);
    });

    it('função já presente na página: não registra de novo', async function () {
        let exposed = 0;
        const page = {
            evaluate: async () => true,
            exposeFunction: async () => {
                exposed += 1;
            },
        };
        await exposeFunctionIfAbsent(page, 'x', () => {});
        expect(exposed).to.equal(0);
    });

    it('outros erros continuam subindo', async function () {
        const page = {
            evaluate: async () => false,
            exposeFunction: async () => {
                throw new Error(
                    'Protocol error (Runtime.addBinding): Target closed',
                );
            },
            removeExposedFunction: async () => {},
        };
        let err;
        try {
            await exposeFunctionIfAbsent(page, 'x', () => {});
        } catch (e) {
            err = e;
        }
        expect(err.message).to.match(/Target closed/);
    });
});
