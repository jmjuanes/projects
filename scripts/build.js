import * as fs from "node:fs";
import * as path from "node:path";
import * as dotenv from "dotenv";
import {Octokit} from "@octokit/rest";
import mikel from "mikel";

// get environment data
const env = [".env.example", ".env"]
    .map(file => path.join(process.cwd(), file))
    .filter(file => fs.existsSync(file))
    .map(file => dotenv.parse(fs.readFileSync(file, "utf8")))
    .reduce((prevEnv, content) => Object.assign(prevEnv, content), {});

// get formatted updated date
const getUpdatedDate = () => {
    const now = new Date();
    // Use Intl.DateFileFormat to generate build time
    // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat
    const dateTimeOptions = {
        dateStyle: "full",
        timeStyle: "long",
        timeZone: "CET",
    };
    // Return build info
    return new Intl.DateTimeFormat("en-US", dateTimeOptions).format(now);
};

// extract repo data
const extractRepoData = repo => ({
    name: repo.name,
    description: repo.description || "",
    url: repo.html_url,
    owner: {
        username: repo.owner.login,
        avatar: repo.owner.avatar_url,
        // avatar: `https://github.com/${repo.full_name.split("/")[0]}.png`,
    },
    topics: repo.topics || [],
    stars: repo.stargazers_count,
});

// get user data
export const getData = async () => {
    const data = {
        updated_at: getUpdatedDate(),
    };
    // we can get auth token from env variable or from .env file
    const octokit = new Octokit({
        auth: process?.env?.GITHUB_TOKEN || env.GITHUB_TOKEN,
    });
    // 1. get user information
    const userRequest = await octokit.request("/user");
    data.user = {
        name: userRequest.data.name ?? userRequest.data.login,
        username: userRequest.data.login,
        avatar: userRequest.data.avatar_url,
        // profile: userRequest.data.html_url,
    };
    // 2. get featured repositories
    const featuredRepos = (process.env.FEATURED_REPOS || env.FEATURED_REPOS || "").split(",").filter(Boolean);
    if (featuredRepos.length > 0) {
        data.featured = []; // initialized featured repost list
        for (let i = 0; i < featuredRepos.length; i++) {
            const repoRequest = await octokit.request("GET /repos/{owner}/{repo}", {
                owner: featuredRepos[i].trim().split("/")[0],
                repo: featuredRepos[i].trim().split("/")[1],
            });
            data.featured.push(extractRepoData(repoRequest.data));
        }
    }
    // return parsed data
    return data;
};

// get data and build site
getData().then(data => {
    const template = fs.readFileSync(path.join(process.cwd(), "template.html"), "utf8");
    const content = mikel(template, data);
    fs.writeFileSync(path.join(process.cwd(), "www/index.html"), content, "utf8");
    fs.writeFileSync(path.join(process.cwd(), "www/api.json"), JSON.stringify(data), "utf8");
});
