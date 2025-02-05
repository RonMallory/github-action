import * as crypto from "crypto";
import * as fs from "fs";
import * as fspromises from "fs/promises";
import * as path from "path";
import {
  EndorctlAvailableArch,
  EndorctlAvailableOS,
  RUNNER_TO_ENDORCTL_ARCH,
  RUNNER_TO_ENDORCTL_OS,
  SupportedRunnerArch,
  SupportedRunnerOS,
} from "./constants";
import { ClientChecksumsType, PlatformInfo, VersionResponse } from "./types";

export const createHashFromFile = (filePath: string) =>
  new Promise((resolve) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(filePath)
      .on("data", (data) => hash.update(data))
      .on("end", () => resolve(hash.digest("hex")));
  });

/**
 * Returns the OS and Architecture to be used for downloading endorctl binary,
 * based on the current runner OS and Architecture. Returns the error if runner
 * OS/Arch combination is not supported
 */
export const getPlatformInfo = () => {
  const defaultInfo: PlatformInfo = {
    os: undefined,
    arch: undefined,
    error: undefined,
  };
  const { RUNNER_ARCH, RUNNER_OS } = process.env;
  const allOsList = Object.values(SupportedRunnerOS) as string[];
  const allArchList = Object.values(SupportedRunnerArch) as string[];
  const armOsList = [SupportedRunnerOS.Macos] as string[];
  if (!RUNNER_OS || !allOsList.includes(RUNNER_OS)) {
    return {
      ...defaultInfo,
      error:
        "Unsupported OS! This actions requires one of [Linux, macOS, Windows].",
    };
  }
  if (!RUNNER_ARCH || !allArchList.includes(RUNNER_ARCH)) {
    return {
      ...defaultInfo,
      error:
        "Unsupported Architecture! This actions requires one of [AMD64(X64), ARM64].",
    };
  }
  if (
    RUNNER_ARCH === SupportedRunnerArch.Arm64 &&
    !armOsList.includes(RUNNER_OS)
  ) {
    return {
      ...defaultInfo,
      error: `Architecture ${RUNNER_ARCH} not supported for ${RUNNER_OS}!`,
    };
  }
  return {
    ...defaultInfo,
    os: RUNNER_TO_ENDORCTL_OS[RUNNER_OS as SupportedRunnerOS],
    arch: RUNNER_TO_ENDORCTL_ARCH[RUNNER_ARCH as SupportedRunnerArch],
  };
};

/**
 * Returns the checksum for the given OS and Architecture
 */
export const getEndorctlChecksum = (
  clientChecksums: ClientChecksumsType,
  os?: EndorctlAvailableOS,
  arch?: EndorctlAvailableArch
) => {
  const platformString = `${os}_${arch}`;
  switch (platformString) {
    case `${EndorctlAvailableOS.Linux}_${EndorctlAvailableArch.Amd64}`:
      return clientChecksums.ARCH_TYPE_LINUX_AMD64;
    case `${EndorctlAvailableOS.Macos}_${EndorctlAvailableArch.Amd64}`:
      return clientChecksums.ARCH_TYPE_MACOS_AMD64;
    case `${EndorctlAvailableOS.Macos}_${EndorctlAvailableArch.Arm64}`:
      return clientChecksums.ARCH_TYPE_MACOS_ARM64;
    case `${EndorctlAvailableOS.Windows}_${EndorctlAvailableArch.Amd64}`:
      return clientChecksums.ARCH_TYPE_WINDOWS_AMD64;
    default:
      return "";
  }
};

export const writeJsonToFile = async (jsonString: string) => {
  try {
    const { GITHUB_RUN_ID, RUNNER_TEMP } = process.env;
    const fileName = `result-${GITHUB_RUN_ID}.json`;
    const uploadPath = path.resolve(RUNNER_TEMP ?? __dirname);
    const filePath = path.resolve(RUNNER_TEMP ?? __dirname, fileName);
    await fspromises.writeFile(filePath, jsonString, "utf8");
    return { fileName, filePath, uploadPath };
  } catch (e) {
    return { error: e as Error };
  }
};

/**
 * Type guard for object/Record
 */
export const isObject = (value: unknown): value is Record<string, unknown> => {
  return "object" === typeof value && null !== value;
};

/**
 * Type guard for VersionResponse
 */
export const isVersionResponse = (value: unknown): value is VersionResponse => {
  return (
    isObject(value) &&
    // expect: `Service` property exists
    "Service" in value &&
    isObject(value.Service) &&
    // expect: `Service` property exists
    "ClientChecksums" in value &&
    isObject(value.ClientChecksums)
  );
};
