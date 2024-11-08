import fastGlob from "fast-glob";
import { green } from "kleur/colors";
import micromatch from "micromatch";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import pLimit from "p-limit";

import type { Loader, LoaderContext } from "astro/loaders";

import { ObsidianDocumentSchema } from "./schemas";
import {
  generateId,
  getEntryInfo,
  getRenderFunction,
  isConfigFile,
  posixRelative,
  type RenderedContent,
} from "./utils";

const DEFAULT_PATTERN = "**/*.md";

export type ObsidianMdLoaderOptions = {
  /** The glob pattern to match files, relative to the base directory. Defaults to **\/*.md  */
  pattern?: string | Array<string>;
  /** The base directory to resolve the glob pattern from. Relative to the root directory, or an absolute file URL. Defaults to `.` */
  base?: string | URL;
  /** Enables i18n routing */
  i18n?: boolean;
  /** Base URL where this content should be served. Defaults to collection name. Used for autogenerated permalink */
  url?: string;
  /** Default author */
  author?: string;
};

// Define any options that the loader needs
export const ObsidianMdLoader: (opts: ObsidianMdLoaderOptions) => Loader = (
  opts
) => {
  // Configure the loader

  const fileToIdMap = new Map<string, string>();
  const pattern = opts.pattern ?? DEFAULT_PATTERN;

  // Return a loader object
  return {
    name: "obsidianmd",
    // Called when updating the collection.
    load: async ({
      collection,
      config,
      generateDigest,
      logger,
      parseData,
      store,
      watcher,
    }: LoaderContext): Promise<void> => {
      const untouchedEntries = new Set(store.keys());
      const render = await getRenderFunction(config);

      async function syncData(entry: string, base: URL, files: string[]) {
        const fileUrl = new URL(encodeURI(entry), base);
        const contents = await readFile(fileUrl, "utf-8").catch((err) => {
          logger.error(`Error reading ${entry}: ${err.message}`);
          return;
        });

        const stats = await stat(fileUrl);

        if (!contents && contents !== "") {
          logger.warn(`No contents found for ${entry}`);
          return;
        }

        const { body, data } = await getEntryInfo(
          contents,
          fileUrl,
          entry,
          stats,
          {
            author: opts.author,
            baseUrl,
            files,
            i18n: opts.i18n,
            defaultLocale: config.i18n?.defaultLocale,
          }
        );
        const id = generateId({ entry, base, data });

        untouchedEntries.delete(id);

        const existingEntry = store.get(id);

        const digest = generateDigest(contents);

        if (
          existingEntry &&
          existingEntry.digest === digest &&
          existingEntry.filePath
        ) {
          if (existingEntry.deferredRender) {
            store.addModuleImport(existingEntry.filePath);
          }

          return;
        }

        const filePath = fileURLToPath(fileUrl);
        const relativePath = posixRelative(
          fileURLToPath(config.root),
          filePath
        );

        const parsedData = await parseData({
          id,
          data,
          filePath,
        });

        let rendered: RenderedContent | undefined = undefined;

        try {
          rendered = await render({
            id,
            data: parsedData,
            body,
            filePath,
            digest,
          });
        } catch (error: any) {
          logger.error(`Error rendering ${entry}: ${error.message}`);
        }

        store.set({
          id,
          data: parsedData,
          body,
          filePath: relativePath,
          digest,
          rendered,
          assetImports: rendered?.metadata?.imagePaths,
        });

        fileToIdMap.set(filePath, id);
      }

      // Load data and update the store

      const baseDir = opts.base ? new URL(opts.base, config.root) : config.root;
      const baseUrl = opts.url ?? collection;

      if (!baseDir.pathname.endsWith("/")) {
        baseDir.pathname = `${baseDir.pathname}/`;
      }

      const files = await fastGlob(pattern, {
        cwd: fileURLToPath(baseDir),
      });
      const limit = pLimit(10);

      await Promise.all(
        files.map((entry) => {
          if (isConfigFile(entry, baseDir.toString())) {
            return;
          }

          return limit(async () => {
            await syncData(entry, baseDir, files);
          });
        })
      );

      // Remove entries that were not found this time
      untouchedEntries.forEach((id) => store.delete(id));

      if (!watcher) {
        return;
      }

      const matchesGlob = (entry: string) =>
        !entry.startsWith("../") && micromatch.isMatch(entry, pattern);

      const basePath = fileURLToPath(baseDir);

      async function onChange(changedPath: string) {
        const entry = posixRelative(basePath, changedPath);
        if (!matchesGlob(entry)) {
          return;
        }
        const baseUrl = pathToFileURL(basePath);
        await syncData(entry, baseUrl, files);
        logger.info(`Reloaded data from ${green(entry)}`);
      }

      watcher.on("change", onChange);

      watcher.on("add", onChange);

      watcher.on("unlink", async (deletedPath) => {
        const entry = posixRelative(basePath, deletedPath);
        if (!matchesGlob(entry)) {
          return;
        }
        const id = fileToIdMap.get(deletedPath);
        if (id) {
          store.delete(id);
          fileToIdMap.delete(deletedPath);
        }
      });
    },
    // Optionally, define the schema of an entry.
    // It will be overridden by user-defined schema.
    schema: async () => ObsidianDocumentSchema,
  };
};