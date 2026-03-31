module.exports = function(config, optimist) {
    optimist
        .version(false)
        .describe("config", "name of the client config to compile")
        .describe("server-config", "name of the client server config to take the statics from")
        .default("server-config", "ide")
        .describe("server-settings", "name of the server settings")
        .default("server-settings", "devel")
        .describe("skin", "name of the skin to compile")
        .describe("module", "name of the module to compile")
        .describe("worker", "name of the worker to compile")
        .describe("compress", "whether to uglify the output")
        .default("compress", config.cdn.compress)
        .boolean("compress")
        .describe("obfuscate", "whether to obfuscate variable names in the output")
        .default("obfuscate", config.cdn.obfuscate)
        .boolean("obfuscate")
        .describe("local", "whether to compile for the local version")
        .default("local", false)
        .boolean("local")
        .describe("keep-less", "whether to keep less/css in the compiled config")
        .default("keep-less", false)
        .boolean("keep-less")
        .describe("compress-output-dir-prefix", "folder prefix to add compressed files in addition to uncompressed files")
        .boolean("link-cdn-files")
        .default("link-cdn-files", false)
        .boolean("skip-duplicates")
        .describe("skip-duplicates", "whether to build files for identical configs")
        .default("skip-duplicates", false)
        .boolean("copy-static-resources")
        .describe("cache", "cache directory")
        .default("cache", config.cdn.cacheDir)
        .describe("cdn-version", "override version")
        .default("cdn-version", config.cdn.version);

    var argv = optimist.argv;
    if (argv.help)
        return null;

    return [
        "./c9.static/connect-static",
        {
            packagePath: "./c9.static/build",
            version: argv["cdn-version"],
            cache: argv.cache,
            compress: argv.compress,
            obfuscate: argv.obfuscate,
            baseUrl: config.cdn.baseUrl + "/" + config.cdn.version,
            config: argv["server-config"],
            settings: argv["server-settings"],
            keepLess: argv["keep-less"],
            link: argv["link-cdn-files"]
        }, {
            packagePath: "./c9.static/cdn.cli",
            skin: argv.skin,
            config: argv.config,
            worker: argv.worker,
            module: argv.module,
            withSkins: argv["with-skins"],
            skipDuplicates: argv["skip-duplicates"],
            copyStaticResources: argv["copy-static-resources"],
            compressOutputDirPrefix: argv["compress-output-dir-prefix"],
            compress: argv.compress,
            obfuscate: argv.obfuscate,
        }, {
            packagePath: "./c9.core/ext"
        }, {
            packagePath: "./c9.logtimestamp/logtimestamp",
            mode: config.mode
        },
    ];
};
