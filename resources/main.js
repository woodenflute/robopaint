/**
 * @file Holds all initially loaded and Node.js specific initialization code,
 * central cncserver object to control low-level non-restful APIs, and general
 * "top-level" UI initialization for settings.
 */

// Must use require syntax for including these libs because of node duality.
$ = jQuery = require('jquery');
jQuery.migrateMute = true; // Disable to allow jqMigrate debug.



// TODO: This is a bit of a mess. We need to rely on FAR fewer globals, and
// initializing them so early means its harder to catch errors.
try {
  _ = require('underscore');
  i18n = require('i18next-client');

  var path = require('path');
  var bytes = require('bytes');
  var appPath = path.join(__dirname, '/');
  var rpRequire = require(appPath + 'rp_modules/rp.require');

  // Define which modes are enabled by default, no longer provided by modes.
  var coreModes = ['edit', 'print'];

  var currentLang = "";
  var fs = require('fs-plus');
  var cncserver = require('cncserver');
  var isModal = false;
  var initializing = false;
  var appMode = 'home';

  // Set the global scope object for any robopaint level details needed by other modes
  var robopaint = {
    settings: {}, // Holds the "permanent" app settings data
    statedata: {}, // Holds per app session volitile settings
    cncserver: cncserver, // Holds the reference to the real CNC server object with API wrappers
    $: $, // Top level jQuery Object for non-shared object bindings
    appPath: appPath, // Absolute App path to prefix relative dir locations
    utils: rpRequire('utils'),
    get currentMode() {
      return appMode === "home" ? {robopaint: {}} : this.modes[appMode];
    }
  };

  // Add the Node CNCServer API wrapper
  rpRequire('cnc_api')(cncserver, robopaint.utils.getAPIServer(robopaint.settings));

  // currentBot lies outside of settings as it actually controls what settings will be loaded
  robopaint.currentBot = robopaint.utils.getCurrentBot();

  // Option buttons for connections
  // TODO: Redo this is as a message management system.
  // Needs approximately same look, obvious, modal, sub-buttons. jQuery UI may
  // not be quite enough. Requires some research (and good understanding of
  // what this is currently used for, and what/if the other modes may make use of it).
  var $options;
  var $stat;

  rpRequire('manager'); // Manage state and messages
  rpRequire('cnc_utils'); // Canvas calculation utils
  rpRequire('commander'); // Simple command queuing
  rpRequire('wcb'); // WaterColorBot Specific group commands
  rpRequire('mediasets') // Colors and other media specific details.
} catch(e) {
  console.log(e);
}

/**
 * Central home screen initialization (called after translations have loaded)
 */
function startInitialization() {
 initializing = true;

 try {

  // Load the modes (adds to settings content)
  loadAllModes();

  // Bind settings controls
  bindSettingsControls();

  // Load the colorset configuration data (needs to happen before settings are
  // loaded and a colorset is selected.
  getColorsets();

  // Load up initial settings!
  // @see scripts/main.settings.js
  loadSettings();

  // Load the history list.
  initHistoryload();

  // Actually try to init the connection and handle the various callbacks
  startSerial();

 } catch(e) {
   console.log(e)
 }
}



/**
 * Actually does the switching between modes (no checking/confirmation steps)
 *
 * @param {String} mode
 *   The mode's machine name. NOTE: Does no sanity checks!
 */
robopaint.switchMode = function(mode, callback) {
  // Don't switch modes if already there, unless debug mode on.
  if (appMode == mode && !robopaint.settings.rpdebug) {
    return;
  }

  appMode = mode; // Set the new mode

  $target = $('a#bar-' + mode);

  // Select toolbar element (and deselect last)
  $target.addClass('selected');

  switch (mode) {
    case 'home':

      break;
    default:

  }
};


/**
 * Initialize the Socket.IO websocket connection
 */
function initSocketIO(){
  if (robopaint.socket) robopaint.socket.destroy();

  // Add Socket.IO include now that we know where from and the server is running
  var server = robopaint.cncserver.api.server;
  var serverPath = server.protocol + '://' + server.domain + ':' + server.port;
  robopaint.socket = io.connect(serverPath);
  cncserver.socket = robopaint.socket;
  $(robopaint).trigger('socketIOComplete');
  return serverPath;
}

/**
 * Binds all the callbacks functions for controlling CNC Server via its Node API
 */
function startSerial(){
  setMessage('status.start', 'loading');

  try {
    // Report runner messages direct to the main console.
    $runner[0].addEventListener('console-message', function(e) {
      console.log('RUNNER:', e.message);
    });

    cncserver.start({
      botType: robopaint.currentBot.type,
      success: function() {
        setMessage('status.found');
      },
      error: function(err) {
        setMessage('status.error', 'warning', ' - ' + err.message);
      },
      connect: function() {
        setMessage('status.success', 'success');
        setModal(false);

        // If caught on startup...
        if (initializing) {
          initializing = false;
        }

        // Initialize settings...
        loadSettings();
        robopaint.utils.saveSettings(robopaint.settings);

        // Init sockets for data stream
        initSocketIO();
      },
      disconnect: function() {
        setModal(true);
        setMessage('status.disconnect', 'error');
      }
    });
  } catch(e) {
    handleInitError('Serial Start', e);
  }
}

/**
 * Runs on application close request to catch exits and alert user with dialog
 * if applicable depending on mode status
 */
function onClose(e) {
  // Allow for quick refresh loads only with devtools opened.
  if (mainWindow.isDevToolsOpened()) {
    if (!document.hasFocus()) {
      app.relaunch();
      app.exit();
    }
  }

  checkModeClose(true);
  e.preventDefault();
  e.returnValue = false;
}


/**
 * Runs current subwindow/mode specific close delay functions (if they exist).
 *
 * @param {Boolean} isGlobal
 *   Demarks an application level quit, function is also called for mode changes
 * @param {String} destination
 *   Name of mode change target. Used to denote special reactions.
 */

var targetMode; // Hold onto the target ode to change to

function continueModeChange() {
  var mode = targetMode[0].id.split('-')[1];
  robopaint.switchMode(mode); // Actually switch to the mode
}


/**
 * Simple wrapper for set the "current" SVG data for the current mode.
 *
 * @param  {string} svgFile
 *   The file path to the XML/SVG string data to set.
 * @return {undefined}
 */
robopaint.setModeSVG = function(svgFile) {
  fs.readFile(svgFile, function(err, fileContents){
    if (!err) {
      // Push the files contents into the localstorage object
      localStorage.setItem('svgedit-default', fileContents);

      // Resave the cache and update the history list.
      robopaint.utils.saveSVGCacheFile(fileContents);
      robopaint.reloadHistory();

      // Tell the current mode that it happened.
      cncserver.pushToMode('loadSVG');

    }
  });
};

/**
 * Fetches all colorsets available from the colorsets dir
 */
function getColorsets() {
  // Load the sets. Must happen here to get translations.
  robopaint.media.load();

  //  Clear the menu (prevents multiple copies appearing on language switch)
  $('#colorset').empty();

  // Actually add the colorsets in the correct weighted order to the dropdown
  _.each(robopaint.media.setOrder, function(setIndex){
    var c = robopaint.media.sets[setIndex];
    $('#colorset').append(
      $('<option>')
        .attr('value', setIndex)
        .text(c.type + ' - ' + c.name)
        .prop('selected', setIndex == robopaint.settings.colorset)
        .prop('disabled', !c.enabled) // Disable unavailable options
    );
  });

  // No options? Disable color/mediasets
  if (!$('#colorset option').length) {
    $('#colorsets').hide();
  }

  /*
  // TODO: This feature to be able to add custom colorsets has been sitting unfinished for
  // quite some time and seriously needs a bit of work. see evil-mad/robopaint#70

  // Menu separator
  $('#colorset').append($('<optgroup>').attr('label', ' ').addClass('sep'));

  // TODO: Append "in memory" custom sets here
  // These are new custom colorsets created by the new feature (not yet
  // completed), saved in new localStorage variable to avoid tainting settings.

  // Add "Create new" item
  $('#colorset').append(
    $('<option>')
      .attr('value', '_new')
      .text(robopaint.t('settings.output.colorsets.add'))
      .addClass('add')
  );
  */

  // Initial run to populate settings window
  updateColorSetSettings();
}

/**
 * Load all modes within the application
 */
function loadAllModes(){
  var modesDir = path.join(appPath, 'node_modules/');
  var files = fs.readdirSync(modesDir);
  var modes = {};
  var modeDirs = [];

  // List all files, only add directories
  for(var i in files) {
    if (fs.statSync(modesDir + files[i]).isDirectory()) {
      modeDirs.push(files[i]);
    }
  }

  // Move through each mode package JSON file...
  for(var i in modeDirs) {
    var modeDir = path.join(modesDir, modeDirs[i]);
    var package = {};

    if (fs.existsSync(path.join(modeDir, 'package.json'))) {
      try {
        package = require(path.join(modeDir, 'package.json'));
      } catch(e) {
        console.error('Problem reading mode package:', e)
        // Silently fail on bad parse!
        continue;
      }
    } else {
      continue;
    }

    // This a good file? if so, lets make it ala mode!
    if (package['robopaint-type'] === "mode" && _.has(package.robopaint, 'index')) {
      // TODO: Add FS checks to see if its index file actually exists
      package.root = path.join(modesDir, modeDirs[i], '/');
      package.index = path.join(package.root, package.robopaint.index);
      modes[package.robopaint.name] = package;

      // Load any persistent scripts into the DOM
      if (package.robopaint.persistentScripts) {
        _.each(package.robopaint.persistentScripts, function(scriptPath){
          $('<script>').attr('src', path.join(package.root, scriptPath)).appendTo('head');
        });
      }
    }
  }

  // Calculate correct order for modes based on package weight (reverse)
  var order = Object.keys(modes).sort(function(a, b) {
    return (modes[b].robopaint.weight - modes[a].robopaint.weight)
  });

  // Build external robopaint.modes in correct order
  robopaint.modes = _.chain(modes)
    .sortBy(function(mode){ return mode.robopaint.weight; })
    .indexBy(function(mode){ return mode.robopaint.name; })
    .value();


  // Grab enabled modes
  var set = robopaint.utils.getSettings();
  var enabledModes = {};

  if (set && set.enabledmodes) {
    enabledModes = set.enabledmodes;
  }

  // Move through all approved modes based on mode weight and add DOM
  for(var i in order) {
    var name = order[i];
    var m = modes[name];

    // This is the minimum enabled modes, other modes are enabled during
    // settings load/apply when it gets around to it.
    robopaint.modes[name].enabled = !_.isUndefined(enabledModes[name]) ? enabledModes[name] : (coreModes.indexOf(name) !== -1);

    // Add the toolbar link icon

    // This monstrosity is to ensure no matter where it lives, we can find the
    // correct relative path to put in the background image location. This is
    // especially picky on  as the absolute backslashes are mangled on
    // URI encode and will be flipped at the end via the global replace.
    var iconURI = path.relative(
      path.join(appPath, 'resources'),
      path.join(m.root, m.robopaint.graphics.icon)
    ).replace(/\\/g, '/');

    var i18nStr = "modes." + m.robopaint.name + ".info.";
  }

}



/**
 * Set modal message
 *
 * @param {String} transKey
 *   Translation key to be displayed
 * @param {String} mode
 *   Optional extra class to add to message element
 */
function setMessage(transKey, mode, append){
  if (transKey) {
    if (!append) append = '';
    $('b', $stat)
      .attr('data-i18n', transKey)
      .text(robopaint.t(transKey) + append);
  }

  if (mode) {
    $stat.attr('class', mode);
  }

}

/**
 * Set modal status
 *
 * @param {Boolean} toggle
 *   True for modal overlay on, false for off.
 */
function setModal(toggle){
  isModal = toggle;
}

