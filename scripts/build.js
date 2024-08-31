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
    private: repo.private,
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
    const reposCache = new Map();
    const data = {
        updated_at: getUpdatedDate(),
    };
    // we can get auth token from env variable or from .env file
    const octokit = new Octokit({
        auth: process?.env?.GITHUB_TOKEN || env.GITHUB_TOKEN,
    });
    // fetch repository
    const fetchRepo = async (owner, name) => {
        if (!reposCache.has(`${owner}/${name}`)) {
            const repoRequest = await octokit.request("GET /repos/{owner}/{name}", {
                owner: owner,
                name: name,
            });
            reposCache.set(`${owner}/${name}`, extractRepoData(repoRequest.data));
        }
        return reposCache.get(`${owner}/${name}`);
    };
    // 1. get user information
    const userRequest = await octokit.request("/user");
    data.user = {
        name: userRequest.data.name ?? userRequest.data.login,
        username: userRequest.data.login,
        avatar: userRequest.data.avatar_url,
        url: userRequest.data.html_url,
    };
    // 2. get featured repositories
    const featuredRepos = (process.env.FEATURED_REPOS || env.FEATURED_REPOS || "").split(",").filter(Boolean);
    if (featuredRepos.length > 0) {
        data.featured = []; // initialized featured repost list
        for (let i = 0; i < featuredRepos.length; i++) {
            const repoName = featuredRepos[i];
            const repoRequest = await octokit.request("GET /repos/{owner}/{repo}", {
                owner: featuredRepos[i].trim().split("/")[0],
                repo: featuredRepos[i].trim().split("/")[1],
            });
            reposCache.set(repoName, extractRepoData(repoRequest.data));
            data.featured.push(reposCache.get(repoName));
        }
    }
    // 3. get contributions
    const contributionsLimit = parseInt(process.env.CONTRIBUTIONS_LIMIT ?? env.CONTRIBUTIONS_LIMIT ?? 0) || 0;
    // TODO: we would need to review this section, to check if we need to perform an additional query (or queries)
    // to get more contributions, if all of them are excluded because are on private repos or are cancelled PRs
    const contributionsRequest = await octokit.request("GET /search/issues", {
        q: `type:pr+author:"${data.user.username}"`,
        per_page: 50,
        page: 1,
    });
    // filter out closed PRs that are not merged
    const filteredPrs = contributionsRequest.data.items.filter(pr => {
        return !(pr.state === "closed" && !pr.pull_request?.merged_at);
    });
    if (filteredPrs.length > 0 && contributionsLimit > 0) {
        data.contributions = [];
        let addedContributions = 0;
        for (let i = 0; i < filteredPrs.length && addedContributions < contributionsLimit; i++) {
            const pr = filteredPrs[i];
            const [owner, name] = pr.repository_url.split("/").slice(-2);
            const repo = await fetchRepo(owner, name);
            if (!repo.private) {
                data.contributions.push({
                    repo: repo,
                    title: pr.title,
                    url: pr.html_url,
                    // currently we only support "merged" or "open" as PR state
                    state: pr.pull_request?.merged_at ? "merged" : "open",
                });
                addedContributions = addedContributions + 1;
            }
        }
    }
    // return parsed data
    return data;
};

// get data and build site
getData().then(data => {
    const template = fs.readFileSync(path.join(process.cwd(), "template.html"), "utf8");
    const content = mikel(template, data, {});
    fs.writeFileSync(path.join(process.cwd(), "www/index.html"), content, "utf8");
    fs.writeFileSync(path.join(process.cwd(), "www/api.json"), JSON.stringify(data), "utf8");
});
