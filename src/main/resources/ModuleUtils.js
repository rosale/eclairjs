/*
 * Copyright 2015 IBM Corp.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var ModuleUtils = {};

/**
 * Utils to keep track of required/loaded Modules for lambda function use.
 * Do not user Logger as this needs to be loaded before jvm-npm and needs to
 * be dependant free.
 */

ModuleUtils.requires = {};

ModuleUtils.addRequiredFile = function(module) {
    if (ModuleUtils.requires[module.modname]) {
        //print("ModuleUtils.addRequiredFile - Module already required: "+module.modname);
    } else {
        // include the path
        //print("ModuleUtils.addRequiredFile - ADDING MODULE: "+module.modname);
        //print("WITH BODY: "+module.body);
        ModuleUtils.requires[module.modname] = module;

        // Make sure it's loaded in Nashorn
        ModuleUtils.loadFileInNashorn(module);
    }
};

ModuleUtils.getRequiredFile = function(module) {
    if (typeof module === "function") {
        return ModuleUtils.getRequiredFileByExport(module);
    }

    var name = typeof module === 'string' ? module : ((module && module.modname) ? module.modname : "");
    //print("get requiredFile name: "+name);
    //ModuleUtils._printRequires("From getRequiredFile");

    var requiredMod = ModuleUtils.requires[name];
    if (!requiredMod) {
        //print("ModuleUtils.getRequiredFile file not found - going to try and load");
        // this could be a worker node - try and load it
        requiredMod = ModuleUtils._tryToLoadFile(module);
    }
    return requiredMod;
};

ModuleUtils.getRequiredFileById = function(modid) {
    //print("ModuleUtils.getRequiredFileById for modid: "+modid);
    for (var name in ModuleUtils.requires) {
        //print("ModuleUtils.getRequiredFileById testing name: "+name);
        if (ModuleUtils.requires[name].id === modid) {
            return ModuleUtils.requires[name];
        }
    };
};

function getModIdFromExport(func) {
    // This is a little bit of a hack - require is defined in jvm-npm but
    // caches any exports for any already required modules. We don't want to add
    // exports to the Module's metadata that is stored in ModuleUtils.requires so
    // it doesn't get Serialized as part of bound lambda argument.   
    var cache = require.cache;
    if (cache) {
        for (var modid in cache) {
            if ((typeof cache[modid] === "function") && (cache[modid].toString() === func.toString())) {
                return {modid: modid};
            } else if (typeof cache[modid] === "object"){
                for (var exp in cache[modid]) {
                    //print("cache[modid][exp]: "+cache[modid][exp]);
                    if (typeof cache[modid][exp] === "function" && cache[modid][exp].toString() === func.toString()) {
                        return {modid: modid, expname: exp};
                    }
                }
            }
        }
    }
}

ModuleUtils.getRequiredFileByExport = function(func) {
    //print("ModuleUtils.getRequiredFileByExport func: "+func.toString());
    var obj = getModIdFromExport(func) || {},
        modid = obj.modid || "",
        expname = obj.expname;
    //ModuleUtils._printRequires();
    //print("ModuleUtils.getRequiredFileByExport modid: "+modid);
    var mod = ModuleUtils.getRequiredFileById(modid);
    if (mod) {
        mod.setExportName(expname);
        return mod;
    }
};

ModuleUtils.isModule = function(obj) {
    //print("ModuleUtils.isModule obj: "+obj.toString());
    if (typeof obj === "function") {
        var mod = ModuleUtils.getRequiredFileByExport(obj);
        return typeof mod !== "undefined";
    }
    return obj && obj.modname;
};

ModuleUtils.getModuleFromJavaPackageAndClass = function(packageName, className) {
    var package = packageName ? packageName.split("org.apache.spark.") : [];
    className = className || "";

    var modname = (package.length > 1 ? package[1].replace(".", "\/")+"\/" : "") + className; 
    //print("----->getModuleFromJavaPackageAndClass modname: " + modname);

    return ModuleUtils.requires[modname];
};

ModuleUtils.getParent = function(mod) {
    //print("*****ModuleUtils.getParent for: "+mod.toString());
    //print("*****ModuleUtils.getParent for parent: "+mod.parent);
    return  ModuleUtils.getRequiredFileById(mod.parent ? mod.parent.id : "");
};

ModuleUtils.loadFileInNashorn = function(mod) {
    if (mod && mod.id) {
        try {
            var e = org.eclairjs.nashorn.NashornEngineSingleton.getEngine();
            var filename = mod.core ? ModuleUtils._getResourcePath(mod.id) : mod.filename;
            //print("Going to try and load in Nashorn filename: "+filename);
            engine.eval("load('" + filename + "');");
        } catch(exc) {
            print("Could not load module in Nashron: "+mod.id);
            print(exc);
        }
    }
};

/*
 * On worker node so have to try and manually find and load required required file.
 */
ModuleUtils._tryToLoadFile = function(mod) {
    //print('ModuleUtils._tryToLoadFile: '+mod.toString());
    try {
        var e = org.eclairjs.nashorn.NashornEngineSingleton.getEngine();
        var require = true;

        // Save off any exportname that has been determined by master as it will be lost once
        // require is envoked again to load module on worker node.
        var expname = mod.exportname || "";

        if (mod.core) {
            // Module is part of JAR but not part of Bootstrap so have to manually load for worker node.
            ModuleUtils.loadFileInNashorn(mod);
        } else {
            // If the required file is NOT on classpath (e.g. core file part of JAR) then it was
            // downlaoded to the worker node via SparkContext.addFile and we have to get it via
            // SparkFiles to find it's absolute path and then manually load it as it was not part
            // of bootstrap process for the NashronSingletonEngine running on worker node.
            var filename = mod.modname + ModuleUtils._getModuleExtension(mod.id);
            if (mod.inFolder) {
                var abspath = org.apache.spark.SparkFiles.get(mod.zipfile);
                //print("*******ModuleUtils._tryToLoadFile zipfile abspath: "+abspath);
                try {
                    org.eclairjs.nashorn.Utils.unzipFile(abspath, ".");
                    //print("Going to try and unzip kids: "+mod.zipfile.replace(".zip", "_child_"));
                    org.eclairjs.nashorn.Utils.unzipChildren(mod.zipfile.replace(".zip", "_child_"), ".");
                    //print("Going to try and load file from unzipped file: "+filename);
                    e.eval("load('" + filename  + "');");
                } catch (exc) {
                    print("Cannot unzipFile and loadfile: "+abspath);
                    print(exc);
                    require = false;
                }
            } else {
                var abspath = org.apache.spark.SparkFiles.get(filename);
                //print("*******ModuleUtils._tryToLoadFile that is not in zipfile abspath: "+abspath);
                e.eval("load('" + abspath + "');");
            }
        }

        if (require) {
            // If this is worker node then required module needs to pass thru jvm-npm so it's
            // exports are made "live"/available to lambdas thus we have to simulate "require".
            var reqAddOn = mod.exportname ? "\."+mod.exportname : "";
            //print("About to try and eval/require: "+"require('" + mod.modname + "')"+reqAddOn+";");
            e.eval("require('" + mod.modname + "')"+reqAddOn+";");
        }

        // Before returing set the exportname in the new Module instance so worker node had it too.
        if (ModuleUtils.requires[mod.modname]) {
            ModuleUtils.requires[mod.modname].setExportName(expname);
        }
        return ModuleUtils.requires[mod.modname];
    } catch(exc) {
        print("ModuleUtils._tryToLoadFile CANNOT load file in Nashorn engine: "+mod.id);
        print(exc);
    }
    return null;
};

ModuleUtils._getModuleExtension = function(id) {
    return id.slice(id.lastIndexOf("\."), id.length);
};

ModuleUtils._getResourcePath = function(filename) {
    var classloader = java.lang.Thread.currentThread().getContextClassLoader();
    return classloader.getResource(filename);
}

ModuleUtils._printRequires = function(msg) {
    var output = "";
    for (var name in ModuleUtils.requires) {
        output += name + ': ' + ModuleUtils.requires[name]+'; ';
    }
    print("ModuleUtils.printRequires msg: "+(msg || ""));
    print("ModuleUtils.printRequires output: "+output);
};

