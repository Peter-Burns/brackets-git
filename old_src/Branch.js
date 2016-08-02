define(function (require, exports) {
    "use strict";

    var _                       = brackets.getModule("thirdparty/lodash"),
        CommandManager          = brackets.getModule("command/CommandManager"),
        Dialogs                 = brackets.getModule("widgets/Dialogs"),
        EditorManager           = brackets.getModule("editor/EditorManager"),
        FileSyncManager         = brackets.getModule("project/FileSyncManager"),
        FileSystem              = brackets.getModule("filesystem/FileSystem"),
        Menus                   = brackets.getModule("command/Menus"),
        PopUpManager            = brackets.getModule("widgets/PopUpManager"),
        StringUtils             = brackets.getModule("utils/StringUtils"),
        DocumentManager         = brackets.getModule("document/DocumentManager"),
        MainViewManager         = brackets.getModule("view/MainViewManager");

    var Git                     = require("src/git/Git"),
        Events                  = require("src/Events"),
        EventEmitter            = require("src/EventEmitter"),
        ErrorHandler            = require("src/ErrorHandler"),
        Panel                   = require("src/Panel"),
        Preferences             = require("src/Preferences"),
        ProgressDialog          = require("src/dialogs/Progress"),
        Strings                 = require("strings"),
        Utils                   = require("src/Utils"),
        branchesMenuTemplate    = require("text!templates/git-branches-menu.html"),
        newBranchTemplate       = require("text!templates/branch-new-dialog.html"),
        mergeBranchTemplate     = require("text!templates/branch-merge-dialog.html");

    var $gitBranchName          = $(null),
        currentEditor,
        $dropdown;



    function doMerge(fromBranch) {
        Git.getBranches().then(function (branches) {

            var compiledTemplate = Mustache.render(mergeBranchTemplate, {
                fromBranch: fromBranch,
                branches: branches,
                Strings: Strings
            });

            var dialog  = Dialogs.showModalDialogUsingTemplate(compiledTemplate);
            var $dialog = dialog.getElement();
            $dialog.find("input").focus();

            var $toBranch = $dialog.find("[name='branch-target']");
            var $useRebase = $dialog.find("[name='use-rebase']");
            var $useNoff = $dialog.find("[name='use-noff']");

            if (fromBranch === "master") {
                $useRebase.prop("checked", true);
            }
            if ($toBranch.val() === "master") {
                $useRebase.prop("checked", false).prop("disabled", true);
            }

            // fill merge message if possible
            var $mergeMessage = $dialog.find("[name='merge-message']");
            $mergeMessage.attr("placeholder", "Merge branch '" + fromBranch + "'");
            $dialog.find(".fill-pr").on("click", function () {
                var prMsg = "Merge pull request #??? from " + fromBranch;
                $mergeMessage.val(prMsg);
                $mergeMessage[0].setSelectionRange(prMsg.indexOf("???"), prMsg.indexOf("???") + 3);
            });

            // load default value for --no-ff
            var useNoffDefaultValue = Preferences.get("useNoffDefaultValue");
            if (typeof useNoffDefaultValue !== "boolean") { useNoffDefaultValue = true; }
            $useNoff.prop("checked", useNoffDefaultValue);

            // can't use rebase and no-ff together so have a change handler for this
            $useRebase.on("change", function () {
                var useRebase = $useRebase.prop("checked");
                $useNoff.prop("disabled", useRebase);
                if (useRebase) { $useNoff.prop("checked", false); }
            }).trigger("change");

            dialog.done(function (buttonId) {
                // right now only merge to current branch without any configuration
                // later delete merge branch and so ...
                var useRebase = $useRebase.prop("checked");
                var useNoff = $useNoff.prop("checked");
                var mergeMsg = $mergeMessage.val();

                // save state for next time branch merge is invoked
                Preferences.set("useNoffDefaultValue", useNoff);

                if (buttonId === "ok") {

                    if (useRebase) {

                        Git.rebaseInit(fromBranch).catch(function (err) {
                            throw ErrorHandler.showError(err, "Rebase failed");
                        }).then(function (stdout) {
                            Utils.showOutput(stdout, Strings.REBASE_RESULT).finally(function () {
                                EventEmitter.emit(Events.REFRESH_ALL);
                            });

                        });

                    } else {

                        Git.mergeBranch(fromBranch, mergeMsg, useNoff).catch(function (err) {
                            throw ErrorHandler.showError(err, "Merge failed");
                        }).then(function (stdout) {
                            Utils.showOutput(stdout, Strings.MERGE_RESULT).finally(function () {
                                EventEmitter.emit(Events.REFRESH_ALL);
                            });
                        });

                    }

                }
            });
        });
    }

    function _reloadBranchSelect($el, branches) {
        var template = "{{#branches}}<option value='{{name}}' remote='{{remote}}' " +
            "{{#currentBranch}}selected{{/currentBranch}}>{{name}}</option>{{/branches}}";
        var html = Mustache.render(template, { branches: branches });
        $el.html(html);
    }

    function closeNotExistingFiles(oldBranchName, newBranchName) {
        return Git.getDeletedFiles(oldBranchName, newBranchName).then(function (deletedFiles) {

            var gitRoot     = Preferences.get("currentGitRoot"),
                openedFiles = MainViewManager.getWorkingSet(MainViewManager.ALL_PANES);

            // Close files that does not exists anymore in the new selected branch
            deletedFiles.forEach(function (dFile) {
                var oFile = _.find(openedFiles, function (oFile) {
                    return oFile.fullPath == gitRoot + dFile;
                });
                if (oFile) {
                    DocumentManager.closeFullEditor(oFile);
                }
            });

            EventEmitter.emit(Events.REFRESH_ALL);

        }).catch(function (err) {
            ErrorHandler.showError(err, "Getting list of deleted files failed.");
        });
    }

    function handleEvents() {
        $dropdown.on("click", "a.git-branch-new", function (e) {
            e.stopPropagation();

            Git.getAllBranches().catch(function (err) {
                ErrorHandler.showError(err);
            }).then(function (branches) {

                var compiledTemplate = Mustache.render(newBranchTemplate, {
                    branches: branches,
                    Strings: Strings
                });

                var dialog  = Dialogs.showModalDialogUsingTemplate(compiledTemplate);

                var $input  = dialog.getElement().find("[name='branch-name']"),
                    $select = dialog.getElement().find(".branchSelect");

                $select.on("change", function () {
                    if (!$input.val()) {
                        var $opt = $select.find(":selected"),
                            remote = $opt.attr("remote"),
                            newVal = $opt.val();
                        if (remote) {
                            newVal = newVal.substring(remote.length + 1);
                            if (remote !== "origin") {
                                newVal = remote + "#" + newVal;
                            }
                        }
                        $input.val(newVal);
                    }
                });

                _reloadBranchSelect($select, branches);
                dialog.getElement().find(".fetchBranches").on("click", function () {
                    var $this = $(this);
                    ProgressDialog.show(Git.fetchAllRemotes())
                        .then(function () {
                            return Git.getAllBranches().then(function (branches) {
                                $this.prop("disabled", true).attr("title", "Already fetched");
                                _reloadBranchSelect($select, branches);
                            });
                        }).catch(function (err) {
                            throw ErrorHandler.showError(err, "Fetching remote information failed");
                        });
                });

                dialog.getElement().find("input").focus();
                dialog.done(function (buttonId) {
                    if (buttonId === "ok") {

                        var $dialog     = dialog.getElement(),
                            branchName  = $dialog.find("input[name='branch-name']").val().trim(),
                            $option     = $dialog.find("select[name='branch-origin']").children("option:selected"),
                            originName  = $option.val(),
                            isRemote    = $option.attr("remote"),
                            track       = !!isRemote;

                        Git.createBranch(branchName, originName, track).catch(function (err) {
                            ErrorHandler.showError(err, "Creating new branch failed");
                        }).then(function () {
                            closeDropdown();
                            EventEmitter.emit(Events.REFRESH_ALL);
                        });
                    }
                });
            });

        }).on("click", "a.git-branch-link .switch-branch", function (e) {

            e.stopPropagation();
            var newBranchName = $(this).parent().data("branch");

            Git.getCurrentBranchName().then(function (oldBranchName) {
                Git.checkout(newBranchName).then(function () {
                    closeDropdown();
                    return closeNotExistingFiles(oldBranchName, newBranchName);
                }).catch(function (err) { ErrorHandler.showError(err, "Switching branches failed."); });
            }).catch(function (err) { ErrorHandler.showError(err, "Getting current branch name failed."); });

        }).on("mouseenter", "a", function () {
            $(this).addClass("selected");
        }).on("mouseleave", "a", function () {
            $(this).removeClass("selected");
        }).on("click", "a.git-branch-link .trash-icon", function () {

            var branchName = $(this).parent().data("branch");
            Utils.askQuestion(Strings.DELETE_LOCAL_BRANCH,
                              StringUtils.format(Strings.DELETE_LOCAL_BRANCH_NAME, branchName),
                              { booleanResponse: true })
                .then(function (response) {
                    if (response === true) {
                        return Git.branchDelete(branchName).catch(function (err) {

                            return Utils.showOutput(err, "Branch deletion failed", {
                                question: "Do you wish to force branch deletion?"
                            }).then(function (response) {
                                if (response === true) {
                                    return Git.forceBranchDelete(branchName).then(function (output) {
                                        return Utils.showOutput(output);
                                    }).catch(function (err) {
                                        ErrorHandler.showError(err, "Forced branch deletion failed");
                                    });
                                }
                            });

                        });
                    }
                })
                .catch(function (err) {
                    ErrorHandler.showError(err);
                });

        }).on("click", ".merge-branch", function () {
            var fromBranch = $(this).parent().data("branch");
            doMerge(fromBranch);
        });
    }





    function checkBranch() {
        FileSystem.getFileForPath(_getHeadFilePath()).read(function (err, contents) {
            if (err) {
                ErrorHandler.showError(err, "Reading .git/HEAD file failed");
                return;
            }

            contents = contents.trim();

            var m = contents.match(/^ref:\s+refs\/heads\/(\S+)/);

            // alternately try to parse the hash
            if (!m) { m = contents.match(/^([a-f0-9]{40})$/); }

            if (!m) {
                ErrorHandler.showError(new Error("Failed parsing branch name from " + contents));
                return;
            }

            var branchInHead  = m[1],
                branchInUi    = $gitBranchName.text();

            if (branchInHead !== branchInUi) {
                refresh();
            }
        });
    }

    EventEmitter.on(Events.BRACKETS_FILE_CHANGED, function (evt, file) {
        if (file.fullPath === _getHeadFilePath()) {
            checkBranch();
        }
    });

    EventEmitter.on(Events.REFRESH_ALL, function () {
        FileSyncManager.syncOpenDocuments();
        CommandManager.execute("file.refresh");
        refresh();
    });

    EventEmitter.on(Events.BRACKETS_PROJECT_CHANGE, function () {
        refresh();
    });

    EventEmitter.on(Events.BRACKETS_PROJECT_REFRESH, function () {
        refresh();
    });

    exports.refresh = refresh;

});