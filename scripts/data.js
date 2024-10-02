import * as fs from "node:fs";
import * as path from "node:path";
import * as dotenv from "dotenv";
import {Octokit} from "@octokit/rest";

// get environment data
const env = [".env.example", ".env"]
    .map(file => path.join(process.cwd(), file))
    .filter(file => fs.existsSync(file))
    .map(file => dotenv.parse(fs.readFileSync(file, "utf8")))
    .reduce((prevEnv, content) => Object.assign(prevEnv, content), {});

// gneerates a set with the excluded repositories, users or orgs
const getExcludedSet = excludedStr => {
    return new Set((excludedStr || "").split(",").filter(Boolean));
};

// checks if the provided repository is excluded
const isExcluded = (excludedSet, repositoryUrl) => {
    const [owner, name] = repositoryUrl.split("/").slice(-2);
    return excludedSet.has(owner) || excludedSet.has(owner + "/" + name);
};

// Get the commit that belongs to a release
const getReleaseCommit = commits => {
    const releaseCommit = (commits || []).filter(commit => {
        return commit.message.includes("release") || commit.message.includes("Release");
    });
    return releaseCommit[0] || null;
};

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
    homepage: repo.homepage,
    license: (repo?.license?.name || "").replace("License", "").trim(),
    owner: {
        username: repo.owner.login,
        avatar: repo.owner.avatar_url,
    },
    topics: repo.topics || [],
    stars_count: repo.stargazers_count || 0,
    // issues_count: repo.open_issues_count || 0,
});

// fetch data
export const fetchData = async () => {
    const reposCache = new Map();
    const data = {
        updated_at: getUpdatedDate(),
    };
    // we can get auth token from env variable or from .env file
    const octokit = new Octokit({
        auth: process?.env?.GH_TOKEN || env.GH_TOKEN,
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
    // initialize excluded sets
    // It can be a single user or organization (for example 'jmjuanes') or a especifi repo (for example 'jmjuanes/repo')
    const excludedContributions = getExcludedSet(process.env.CONTRIBUTIONS_EXCLUDED || env.CONTRIBUTIONS_EXCLUDED);
    const excludedReleases = getExcludedSet(process.env.RELEASES_EXCLUDED || env.RELEASES_EXCLUDED);
    // 1. get user information
    const userRequest = await octokit.request("/user");
    data.user = {
        name: userRequest.data.name ?? userRequest.data.login,
        username: userRequest.data.login,
        avatar: userRequest.data.avatar_url,
        url: userRequest.data.html_url,
        homepage: userRequest.data.blog,
        location: userRequest.data.location,
    };
    // 2. get featured repositories
    const featuredRepos = (process.env.FEATURED_REPOSITORIES || env.FEATURED_REPOSITORIES || "").split(",").filter(Boolean);
    if (featuredRepos.length > 0) {
        data.featured = []; // initialized featured repost list
        for (let i = 0; i < featuredRepos.length; i++) {
            const [owner, name] = featuredRepos[i].trim().split("/");
            if (owner && name) {
                const repo = await fetchRepo(owner, name);
                data.featured.push(repo);
            }
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
    // Filter out contributions
    const filteredPrs = contributionsRequest.data.items.filter(pr => {
        // 1. exclude closed PRs that have not been merged
        if (!(pr.state === "closed" && !pr.pull_request?.merged_at)) {
            // 2. check if this contribution is not in the excluded contributions list
            if (!isExcluded(excludedContributions, pr.repository_url)) {
                return true;
            }
        }
        // contribution excluded
        return false;
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
                    created_at: pr.created_at,
                    updated_at: pr.updated_at,
                });
                addedContributions = addedContributions + 1;
            }
        }
    }
    // 4. Get latest releases
    const releasesLimit = parseInt(process.env?.RELEASES_LIMIT ?? env.RELEASES_LIMIT ?? 0) || 0;
    if (releasesLimit > 0) {
        data.releases = [];
        const addedReleases = new Set();
        for (let page = 0; page < 3 && addedReleases.size < releasesLimit; page++) {
            const eventsRequest = await octokit.request("GET /users/{username}/events", {
                username: data.user.username,
                per_page: 100,
                page: page,
            });
            const events = (eventsRequest.data || [])
                // Get only push events in public repositories
                .filter(event => event.public && event.type === "PushEvent")
                // Remove excluded repositories from the list of events
                .filter(event => !isExcluded(excludedReleases, event.repo.url))
                // get only commits of releases
                .filter(event => !!getReleaseCommit(event.payload.commits));
            for (let i = 0; i < events.length && addedReleases.size < releasesLimit; i++) {
                const event = events[i];
                const commit = getReleaseCommit(event.payload.commits);
                const version = (commit?.message || "").match(/v?(\d+\.\d+\.\d+(?:-[\w.]+)?)\s*$/)?.[1] || "";
                if (commit && version && !addedReleases.has(event.repo.name + "/" + version)) {
                    const [owner, name] = event.repo.name.split("/");
                    const repo = await fetchRepo(owner, name);
                    data.releases.push({
                        repo: repo,
                        version: "v" + version,
                        url: `https://github.com/${owner}/${name}/releases/tag/v${version}`,
                        commit: {
                            message: commit.message,
                            sha: commit.sha,
                            url: `https://github.com/${owner}/${name}/commit/${commit.sha}`,
                        },
                        created_at: event.created_at,
                    });
                    addedReleases.add(event.repo.name + "/" + version);
                }
            }
        }
    }
    // return parsed data
    return data;
};
