import * as artifact from "@actions/artifact";
import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as github from "@actions/github";
import * as httpm from "@actions/http-client";
import * as io from "@actions/io";
import * as tc from "@actions/tool-cache";

import * as path from "path";
import { EndorctlAvailableOS } from "./constants";
import { SetupProps, VersionResponse } from "./types";
import {
  createHashFromFile,
  getEndorctlChecksum,
  getPlatformInfo,
  writeJsonToFile,
  isVersionResponse,
} from "./utils";

const execOptionSilent = {
  silent: true,
};

/**
 * @throws {Error} when api is unreachable or returns invalid response
 */
const fetchLatestEndorctlVersion = async (api: string) => {
  const _http: httpm.HttpClient = new httpm.HttpClient("endor-http-client");

  const res: httpm.HttpClientResponse = await _http
    .get(`${api}/meta/version`)
    // eslint-disable-next-line github/no-then
    .catch((error) => {
      throw new Error(
        `Failed to fetch latest version of endorctl from Endor Labs API: ${error.toString()}`
      );
    });
  const body: string = await res.readBody();

  let data: VersionResponse | undefined;
  try {
    data = JSON.parse(body);
  } catch (error) {
    throw new Error(`Invalid response from Endor Labs API: \`${body}\``);
  }

  if (!isVersionResponse(data)) {
    throw new Error(`Invalid response from Endor Labs API: \`${body}\``);
  }

  return data;
};

const setupEndorctl = async ({ version, checksum, api }: SetupProps) => {
  try {
    const platform = getPlatformInfo();

    if (platform.error) {
      throw new Error(platform.error);
    }

    const isWindows = platform.os === EndorctlAvailableOS.Windows;

    let endorctlVersion = version;
    let endorctlChecksum = checksum;
    if (!version) {
      core.info(`Endorctl version not provided, using latest version`);

      const data = await fetchLatestEndorctlVersion(api);
      endorctlVersion = data.Service.Version;
      endorctlChecksum = getEndorctlChecksum(
        data.ClientChecksums,
        platform.os,
        platform.arch
      );
    }

    core.info(`Downloading endorctl version ${endorctlVersion}`);
    const url = `https://storage.googleapis.com/endorlabs/${endorctlVersion}/binaries/endorctl_${endorctlVersion}_${
      platform.os
    }_${platform.arch}${isWindows ? ".exe" : ""}`;
    let downloadPath: string | null = null;

    downloadPath = await tc.downloadTool(url);
    const hash = await createHashFromFile(downloadPath);
    if (hash !== endorctlChecksum) {
      throw new Error(
        "The checksum of the downloaded binary does not match the expected value!"
      );
    } else {
      core.info(`Binary checksum: ${endorctlChecksum}`);
    }

    await exec.exec("chmod", ["+x", downloadPath], execOptionSilent);
    const binPath = ".";
    const endorctlPath = path.join(
      binPath,
      `endorctl${isWindows ? ".exe" : ""}`
    );
    await io.mv(downloadPath, endorctlPath);
    core.addPath(binPath);

    core.info(`Endorctl downloaded and added to the path`);
  } catch (error: any) {
    core.setFailed(error);
  }
};

const uploadArtifact = async (scanResult: string) => {
  const artifactClient = artifact.create();
  const artifactName = "endor-scan";

  const { filePath, uploadPath, error } = await writeJsonToFile(scanResult);
  if (error) {
    core.error(error);
  } else {
    const files = [filePath];
    const rootDirectory = uploadPath;
    const options = {
      continueOnError: true,
    };
    const uploadResult = await artifactClient.uploadArtifact(
      artifactName,
      files,
      rootDirectory,
      options
    );
    if (uploadResult.failedItems.length > 0) {
      core.error("Some items failed to export");
    } else {
      core.info("Scan result exported to artifact");
    }
  }
};

async function run() {
  let scanResult = "";

  const scanOptions: exec.ExecOptions = {
    listeners: {
      stdout: (data: Buffer) => {
        scanResult += data.toString();
      },
    },
  };

  try {
    const platform = getPlatformInfo();

    if (platform.error) {
      throw new Error(platform.error);
    }

    const SHOW_PROGRESS = false;
    const API = core.getInput("api");
    const API_KEY = core.getInput("api_key");
    const API_SECRET = core.getInput("api_secret");
    const GCP_CREDENTIALS_SERVICE_ACCOUNT = core.getInput(
      "gcp_service_account"
    );
    const ENABLE_GITHUB_ACTION_TOKEN = core.getBooleanInput(
      "enable_github_action_token"
    );
    const NAMESPACE = core.getInput("namespace");
    const ENDORCTL_VERSION = core.getInput("endorctl_version");
    const ENDORCTL_CHECKSUM = core.getInput("endorctl_checksum");
    const LOG_VERBOSE = core.getBooleanInput("log_verbose");
    const LOG_LEVEL = core.getInput("log_level");
    const SCAN_SUMMARY_OUTPUT_TYPE = core.getInput("scan_summary_output_type");
    const CI_RUN = core.getBooleanInput("ci_run");
    const CI_RUN_TAGS = core.getInput("ci_run_tags");
    const RUN_STATS = core.getInput("run_stats");
    const ADDITIONAL_ARGS = core.getInput("additional_args");
    const EXPORT_SCAN_RESULT_ARTIFACT = core.getBooleanInput(
      "export_scan_result_artifact"
    );
    const ADDITION_OPTIONS = ADDITIONAL_ARGS.split(" ");
    const SARIF_FILE = core.getInput("sarif_file");
    const ENABLE_PR_COMMENTS = core.getBooleanInput("enable_pr_comments");
    const GITHUB_TOKEN = core.getInput("github_token");
    const GITHUB_PR_ID = github.context.payload.pull_request?.number;

    core.info(`Endor Namespace: ${NAMESPACE}`);

    if (!NAMESPACE) {
      core.setFailed(
        "namespace is required and must be passed as an input from the workflow"
      );
      return;
    }
    if (
      !ENABLE_GITHUB_ACTION_TOKEN &&
      !(API_KEY && API_SECRET) &&
      !GCP_CREDENTIALS_SERVICE_ACCOUNT
    ) {
      core.setFailed(
        "Authentication info not found. Either set enable_github_action_token: true or provide one of gcp_service_account or api_key and api_secret combination"
      );
      return;
    }
    await setupEndorctl({
      version: ENDORCTL_VERSION,
      checksum: ENDORCTL_CHECKSUM,
      api: API,
    });

    const repoName = github.context.repo.repo;

    core.info(`Scanning repository ${repoName}`);

    const options = [
      `--namespace=${NAMESPACE}`,
      `--show-progress=${SHOW_PROGRESS}`,
      `--verbose=${LOG_VERBOSE}`,
      `--output-type=${SCAN_SUMMARY_OUTPUT_TYPE}`,
      `--log-level=${LOG_LEVEL}`,
      `--ci-run=${CI_RUN}`,
    ];

    if (API) options.push(`--api=${API}`);

    if (ENABLE_GITHUB_ACTION_TOKEN) {
      options.push(`--enable-github-action-token=true`);
    } else if (API_KEY && API_SECRET) {
      options.push(`--api-key=${API_KEY}`, `--api-secret=${API_SECRET}`);
    } else if (GCP_CREDENTIALS_SERVICE_ACCOUNT) {
      options.push(`--gcp-service-account=${GCP_CREDENTIALS_SERVICE_ACCOUNT}`);
    }

    if (ENABLE_PR_COMMENTS && GITHUB_PR_ID) {
      if (!CI_RUN) {
        core.error(
          "ci_run option must be enabled for PR comments. Either enable CI Run or disable PR comments"
        );
      } else if (!GITHUB_TOKEN) {
        core.error("GITHUB_TOKEN is required for PR comments");
      } else {
        options.push(
          `--enable-pr-comments=true`,
          `--github-pr-id=${GITHUB_PR_ID}`,
          `--github-token=${GITHUB_TOKEN}`
        );
      }
    }

    if (CI_RUN_TAGS) {
      options.push(`--ci-run-tags=${CI_RUN_TAGS}`);
    }
    if (ADDITIONAL_ARGS && ADDITION_OPTIONS.length > 0) {
      options.push(...ADDITION_OPTIONS);
    }
    if (SARIF_FILE) {
      options.push(`--sarif-file=${SARIF_FILE}`);
    }

    let scan_command = `endorctl`;
    options.unshift("scan", "--path=."); // Standard options for scanner
    if (RUN_STATS === "true") {
      // Wrap scan commmand in `time -v` to get stats
      if (platform.os === EndorctlAvailableOS.Windows) {
        core.info("Timing is not supported on Windows runners");
      } else if (platform.os === EndorctlAvailableOS.Macos) {
        options.unshift("-l", scan_command);
        scan_command = `/usr/bin/time`;
      } else if (platform.os === EndorctlAvailableOS.Linux) {
        options.unshift("-v", scan_command);
        scan_command = `time`;
      } else {
        core.info("Timing not supported on this OS");
      }
    }
    await exec.exec(scan_command, options, scanOptions);

    core.info("Scan completed successfully!");
    if (!scanResult) {
      core.info("No vulnerabilities found for given filters.");
    }

    if (
      EXPORT_SCAN_RESULT_ARTIFACT &&
      SCAN_SUMMARY_OUTPUT_TYPE === "json" &&
      scanResult
    ) {
      await uploadArtifact(scanResult);
    }
  } catch {
    core.setFailed("Endorctl Scan Failed");
  }
}

run();

export {};
