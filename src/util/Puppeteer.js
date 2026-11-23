/**
 * Expose a function to the page if it does not exist
 *
 * NOTE:
 * Rewrite it to 'upsertFunction' after updating Puppeteer to 20.6 or higher
 * using page.removeExposedFunction
 * https://pptr.dev/api/puppeteer.page.removeexposedfunction
 *
 * @param {object} page - Puppeteer Page instance
 * @param {string} name
 * @param {Function} fn
 */
async function exposeFunctionIfAbsent(page, name, fn) {
    const exist = await page.evaluate((name) => {
        return !!window[name];
    }, name);
    if (exist) {
        return;
    }
    try {
        await page.exposeFunction(name, fn);
    } catch (err) {
        // Uma tentativa anterior falhou no meio (ex.: "Target closed" no
        // Runtime.addBinding de um frame secundário): o Puppeteer guardou o
        // binding, mas a página não tem a função. Refaz do zero.
        if (!/already exists/i.test(String((err && err.message) || err))) {
            throw err;
        }
        await page.removeExposedFunction(name).catch(() => {});
        await page.exposeFunction(name, fn);
    }
}

module.exports = { exposeFunctionIfAbsent };
