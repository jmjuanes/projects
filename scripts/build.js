import * as fs from "node:fs";
import * as path from "node:path";
import mikel from "mikel";
import {fetchData} from "./data.js";

// get data and build site
const main = async () => {
    const data = await fetchData();
    const template = fs.readFileSync(path.join(process.cwd(), "template.html"), "utf8");
    const content = mikel(template, data, {
        functions: {
            icon: n => `<svg width="1em" height="1em"><use xlink:href="/sprite.svg#${n}"></use></svg>`,
        },
    });
    fs.writeFileSync(path.join(process.cwd(), "www/index.html"), content, "utf8");
    fs.writeFileSync(path.join(process.cwd(), "www/api.json"), JSON.stringify(data), "utf8");
};

main();
