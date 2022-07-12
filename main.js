/**
 *
 * snmp adapter, 
 *		copyright CTJaeger 2017, MIT
 *		copyright McM1957 2022, MIT
 *
 */

/*
 * description if major internal objects
 *
 *	CTXs		object (array) of CTX objectes
 *
 *  CTX         object for one signle device
 *    containing
 *      name       string   name of the device
 *      ipAddr     string   ip address (without port number)
 *      ipPort     number   ip port number
 *      id         string   id of device, dereived from ip address or from name
 *      isIPv6     bool     true if IPv6 to be used
 *      timeout    number   snmp connect timeout (ms)
 *      retryIntvl number   snmp retry intervall (ms)
 *      pollIntvl  number   snmp poll intervall (ms)
 *      snmpVers   number   snmp version
 *      community  string   snmp comunity (v1, v2c)
 *      oids       array of strings
 *                          oids to be read
 *      ids        array of strings
 *                          ids fro oids to be read
 *
 *      pollTimer  object   timer object for poll timer
 *      retryTimer object   timer object for retry timer
 *      session    object   snmp session object
 *      inactive   bool     flag indicating conection status of device
        
 */
 
/* jshint -W097 */
/* jshint strict:false */
/* jslint node: true */
'use strict';

const SNMP_V1 	= 1;
const SNMP_V2c 	= 2;
const SNMP_V3 	= 3;

const MD5 		= 1;
const SHA 		= 2;

const DES 		= 1;
const AES 		= 2;
const AES256B	= 3;
const AES256R	= 4;

/*
 * based on template created with @iobroker/create-adapter v2.1.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils				= require('@iobroker/adapter-core');
const { EXIT_CODES } 	= require('@iobroker/js-controller-common');
const mcmLogger			= require('./lib/mcmLogger');
const mcmInstUtils		= require('./lib/mcmInstUtils');

 // Load modules required by adapter
const snmp = require('net-snmp');

// init installation marker
let doInstall    = false;
let didInstall   = false;

// #################### global variables ####################
let     adapter;    // adapter instance - @type {ioBroker.Adapter}
let     logger;     // mcmLogger instance

const   CTXs 		    = [];		// see description at header of file
let     isConnected     = false; 	// local copy of info.connection state 
let     connUpdateTimer = null;

/**
 * Start the adapter instance
 * @param {Partial<utils.AdapterOptions>} [options]
 */
function startAdapter(options) {
	// Create the adapter and define its methods
	adapter = utils.adapter(Object.assign({}, options, {
		name: 'snmp',

		// ready callback is called when databases are connected and adapter received configuration.
		ready: onReady, // Main method defined below for readability

		// unload callback is called when adapter shuts down - callback has to be called under any circumstances!
		unload: onUnload,

		// If you need to react to object changes, uncomment the following method.
		// You also need to subscribe to the objects with `adapter.subscribeObjects`, similar to `adapter.subscribeStates`.
		// objectChange: (id, obj) => {
		// 	if (obj) {
		// 		// The object was changed
		// 		logger.info(`object ${id} changed: ${JSON.stringify(obj)}`);
		// 	} else {
		// 		// The object was deleted
		// 		logger.info(`object ${id} deleted`);
		// 	}
		// },

		// stateChange is called if a subscribed state changes
		// stateChange: (id, state) => {
		//	if (state) {
		//		// The state was changed
		//		logger.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
		//	} else {
		//		// The state was deleted
		//		logger.info(`state ${id} deleted`);
		//	}
		//},

		// If you need to accept messages in your adapter, uncomment the following block.
		// /**
		//  * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
		//  * Using this method requires "common.messagebox" property to be set to true in io-package.json
		//  */
		// message: (obj) => {
		// 	if (typeof obj === 'object' && obj.message) {
		// 		if (obj.command === 'send') {
		// 			// e.g. send email or pushover or whatever
		// 			logger.info('send command');

		// 			// Send response in callback if required
		// 			if (obj.callback) adapter.sendTo(obj.from, obj.command, 'Message received', obj.callback);
		// 		}
		// 	}
		// },
	}));
    
    logger = new mcmLogger(adapter);
    return adapter;
}

/* *** end of initialization section *** */



// #################### general utility functions ####################

/**
 * Convert name to id
 *
 *		This utility routine replaces all forbidden chars and the characters '-' and any whitespace 
 *		with an underscore ('_').
 *
 * @param   {string}    pName 	name of an object
 * @return  {string} 		    name of the object with all forbidden chars replaced
 * 
 */
function name2id(pName) {
    return (pName || '').replace(adapter.FORBIDDEN_CHARS, '_').replace(/[-\s]/g, '_');
}

/**
 * convert ip to ipStr
 *
 *		This utility routine replaces any dots within an ip address with an underscore ('_').
 *
 * @param {string} 	ip 	ip string with standard foematting
 * @return {string} 	ipStr with all dots removed and useable as identifier
 * 
 */
function ip2ipStr(ip) {
	return (ip || '').replace(/\./g, "_");
}


// #################### object initialization functions ####################

/**
 * initObject - create or reconfigure single object
 *
 *		creates object if it does not exist
 *		overrides object data otherwise
 *		waits for action to complete using await
 *
 * @param {obj} object structure
 * @return
 *
 */
async function initObject(obj) {
	await logger.debug('initobject '+obj._id);
	try{ 
		await adapter.setObjectAsync(obj._id, obj);
	} catch(e) {
		await logger.error ('error initializing obj "' + obj._id + '" ' + e.message);
	}
}

/**
 * initDeviceObjects - initializes all objects related to a device
 *
 * @param   {string}    pId     id of device
 * @param   {string}    pIp     ip of device
 * @return
 *
 */
async function initDeviceObjects(pId, pIp) {
	await logger.debug('initdeviceObjects ('+pId+'/'+pIp+')');

	try{ 
		// create <ip> device object
		await initObject({
					_id: pId,
					type: 'device',
					common: {
						name: pIp
					},
					native: {
					}
				}
			);

		// create <ip>.online state object
		await initObject({
					_id: pId + '.online',
					type: 'state',
					common: {
						name: pIp + ' online',
						write: false,
						read:  true,
						type: 'boolean',
						role: 'indicator.reachable'
					},
					native: {
					}
				}
			);
	} catch(e) {
		await logger.error ('error creating objects for ip "'+pIp+'" ('+pId+'), ' + e.message);
	}
}

/**
 * initOidObjects - initializes objects for one OID
 *
 * @param   {string}    id  if of object
 * @return
 *
 * ASSERTION: root device object is already created
 *
 */
async function initOidObjects(pId, pOid) {
	await logger.debug('initOidObjects ('+pId+')');

	try{ 
		// create OID folder objects
        const idArr = pId.split('.');
        let partlyId = idArr.pop();
		for (let i = 1; i < idArr.length; i++) {
			let el = idArr[i];
            partlyId += '.' + el;
			await initObject({
						_id: partlyId,
						type: 'folder',
						common: {
							name: ''
						},
						native: {
						}
					});
		};

		// create OID state object
		await initObject({
				_id: pId,
				type: 'state',
				common: {
					name:  pId,
//					write: !!OID.write, //## TODO
					read:  true,
					type: 'string',
					role: 'value'
				},
				native: {
//					OID: pOid
				}
			});

	} catch(e) {
		await logger.error ('error processing oid id "'+pId+'" (oid "'+pOid+') - '+e.message);
	}
}

/**
 * initAllObjects - initialize all objects
 *
 * @param
 * @return
 *
 */
async function initAllObjects(){
	await logger.debug('initAllObjects - initializing objects');

    for (let ii=0; ii<CTXs.length; ii++) {
        await initDeviceObjects(CTXs[ii].id, CTXs[ii].ipAddr);  

        for (let jj=0; jj<CTXs[ii].ids.length; jj++){
            await initOidObjects(CTXs[ii].ids[jj], CTXs[ii].oids[jj] );
        }
    }
}



// #################### snmp session handling functions ####################


/**
 * onSessionClose - callback called whenever a session is closed
 *
 * @param {CTX object}  pCTX    CTX object
 * @return
 *
 */
async function onSessionClose(pCTX) {
	await logger.debug('onSessionClose - device '+pCTX.name+' ('+pCTX.ipAddr+')');
	
	clearInterval(pCTX.pollTimer);
	pCTX.pollTimer = null;
	pCTX.session = null;

	pCTX.retryTimer = setTimeout((pCTX) => {
            pCTX.retryTimer = null;
            createSession(pCTX);
		}, pCTX.retryIntvl, pCTX);
}

/**
 * onSessionError - callback called whenever a session encounters an error
 *
 * @param {CTX object} 	pCTX    CTX object
 * @param {object}      pErr    error object
 * @return
 *
 */
async function onSessionError(pCTX, pErr) {
	await logger.debug('onSessionError - device '+pCTX.name+' ('+pCTX.ipAddr+') - '+pErr.toString);
	
// ### to be implemented ###
}

/**
/**
 * createSession - initializes a snmp session to one device and starts reader thread
 *
 * @param   {CTX object}    pCTX    CTX object
 * @return
 *
var options = {
    port: 161,
    retries: 1,
    timeout: 5000,
    backoff: 1.0,
    transport: "udp4",
    trapPort: 162,
    version: snmp.Version1,
    backwardsGetNexts: true,
    idBitsSize: 32
}; */
async function createSession(pCTX) {
	await logger.debug('createSession - device '+pCTX.name+' ('+pCTX.ipAddr+')');
	
	// (re)set device online status
	adapter.setState(pCTX.id + '.online', false, true);

	// close old session if one exists
    if (pCTX.pollTimer ) {
        try {
            clearInterval(pCTX.pollTimer);
        } catch 
        {
            await logger.warn('cannot cancel timer for device "'+pCTX.name+'" ('+pCTX.ip + '), ' + e);
        };
        pCTX.pollTimer = null;
    };
    if (pCTX.session) {
		try {
			pCTX.session.on('error', null ); // avoid nesting callbacks
			pCTX.session.on('close', null ); // avoid nesting callbacks
            pCTX.session.close();
        } catch (e) {
            await logger.warn('cannot close session for device "'+pCTX.name+'" ('+pCTX.ip + '), ' + e);
        }
        pCTX.session = null;
    }

	// create snmp session for device
    if (pCTX.snmpVers == SNMP_V1 ||
        pCTX.snmpVers == SNMP_V2c) {
        
        const snmpTransport = pCTX.isIPv6?"udp6":"udp4";
        const snmpVersion   = (pCTX.snmpVers==SNMP_V1)?snmp.Version1:snmp.Version2c;
        
        pCTX.session = snmp.createSession(pCTX.ipAddr, pCTX.authId, {
                                port: pCTX.ipPort,   // default:161
                                retries: 1,
                                timeout: pCTX.timeout,
                                backoff: 1.0,
                                transport: snmpTransport,
                                //trapPort: 162,
                                version: snmpVersion,
                                backwardsGetNexts: true,
                                idBitsSize: 32
                            });
    } else if (pCTX.snmpVers == SNMP_V3) {
        await logger.error('Sorry, SNMP V3 is not yet supported - device "'+pCTX.name+'" ('+pCTX.ip + ')');
    } else {
        await logger.error('unsupported snmp version code ('+pCTX.snmpVers+') for device "'+pCTX.name+'" ('+pCTX.ip + ')');
    };

    if (pCTX.session) {
        pCTX.session.on('close', () => { onSessionClose(pCTX) } );
        pCTX.session.on('error', (err) => { onSessionError(pCTX, err) } );
        pCTX.pollTimer = setInterval(readOids, pCTX.pollIntvl, pCTX);

        // read one time immediately
        readOids(pCTX);
    };

	await logger.debug('session for device "'+pCTX.name+'" ('+pCTX.ipAddr+')'+(pCTX.session?'':' NOT')+' created');

}

/**
/**
 * readOids - read all oids from a specific target device
 *
 * @param {IP} IP object
 * @return
 *
 */
function readOids(pCTX) {
	logger.debug('readOIDs - device "'+pCTX.name+'" ('+pCTX.ipAddr+')');

	const session 	= pCTX.session;
	const id 		= pCTX.id;
	const oids		= pCTX.oids;
	const ids		= pCTX.ids;
	
    session.get(oids, (err, varbinds) => {
        if (err) {
			// error occured
            logger.debug('[' + id + '] session.get: ' + err.toString());
            if (err.toString() === 'RequestTimedOutError: Request timed out') {
				// timeout error
                if (!pCTX.inactive ) {
                    logger.info('[' + id + '] device disconnected - request timout');
                    pCTX.inactive = true;
                    setImmediate(handleConnectionInfo);
                }
            } else {
				// other error
				if (!pCTX.inactive) {
					logger.error('[' + id + '] session.get: ' + err.toString());
					pCTX.inactive = true;
					setImmediate(handleConnectionInfo);
					}
				}
            adapter.setState(id + '.online', false, true);
        } else {
			// success
            if ( pCTX.inactive ) {
                logger.info('[' + id + '] device (re)connected');
                pCTX.inactive = false;
                setImmediate(handleConnectionInfo);
            }

            adapter.setState(id + '.online', true, true);

			// process returned values
            for (let ii = 0; ii < varbinds.length; ii++) {
                if (snmp.isVarbindError(varbinds[ii])) {
                    logger.warn(snmp.varbindError(varbinds[ii]));
                    adapter.setState(pCTX.ids[ii], null, true, 0x84);
                } else {
                    logger.debug('['+id+'] update '+pCTX.ids[ii]+': '+varbinds[ii].value.toString());
                    adapter.setState(pCTX.ids[ii], varbinds[ii].value.toString(), true);
                }
            }
        }

        if ( !pCTX.initialized ) {
            pCTX.initialized = true;
            setImmediate(handleConnectionInfo);
        }
    });
}

// #################### general housekeeping functions ####################

function handleConnectionInfo() {
	logger.debug('handleConnectionInfo');

    let haveConnection = false;
    for (let ii=0; ii<CTXs.length; ii++) {
		if (!CTXs[ii].inactive)  {
            haveConnection = true;
		}
	}
	
	if (isConnected !== haveConnection)  {
		if (haveConnection) {
			logger.info('instance connected to at least one device');
		} else {
			logger.info('instance disconnected from all devices');
		}
		isConnected = haveConnection;

		logger.debug('info.connection set to '+ isConnected);
		adapter.setState('info.connection', isConnected, true);
	}
}

/**
 * validateConfig - scan and validate config data
 *
 * @param
 * @return
 *
 */
function validateConfig() {
	let ok			= true;

	let oidSets 	= {};
	let authSets	= {};

    logger.debug('validateConfig - verifying oid-sets');

    // ensure that at least empty config exists
    adapter.config.oids     = adapter.config.oids       || []; 
    adapter.config.authSets = adapter.config.authSets   || [];
    adapter.config.devs     = adapter.config.devs       || [];

    if (!adapter.config.oids.length) { 
        logger.error('no oids configured, please add configuration.');
        ok = false;
    };
    
    for (let ii=0; ii < adapter.config.oids.length; ii++) {
        let oid = adapter.config.oids[ii];

        if (!oid.oidAct) continue;

        oid.oidGroup    = oid.oidGroup.trim();
        oid.oidName     = oid.oidName.trim();
        oid.oidOid      = oid.oidOid.trim().replace(/^\./, '');

        let oidGroup = oid.oidGroup;

        if (!oid.oidGroup) { 
            logger.error('oid group must not be empty, please correct configuration.');
            ok = false;
        };

        if (!oid.oidName) { 
            logger.error('oid name must not be empty, please correct configuration.');
            ok = false;
        };

        if (!oid.oidOid) { 
            logger.error('oid must not be empty, please correct configuration.');
            ok = false;
        };

        if (! /^\d+(\.\d+)*$/.test(oid.oidOid)){
            logger.error('oid "'+oid.oidOid+'" has invalid format, please correct configuration.');
            ok = false;
        }
    
        // TODO: oidGroup                       must be unique
        // TODO: oidGroup + oidName             must be unique
        // TODO: oidGroup + oidName + oidOid    must be unique
        
        oidSets[oidGroup] = true;
    
    }

    if (!ok) {
        logger.debug('validateConfig - validation aborted (checks failed)');
        return false;
    }
    
    logger.debug('validateConfig - verifying authorization data');

    for (let ii=0; ii < adapter.config.authSets.length; ii++) {
        let authSet = adapter.config.authSets[ii];
        let authId 	= authSet.authId;
        if (!authId || authId=='') { 
            logger.error('empty authorization id detected, please correct configuration.');
            ok = false;
            continue;
        };
        if (authSets[authSet]) { 
            logger.error('duplicate authorization id '+authId+' detected, please correct configuration.');
            ok = false;
            continue;
        };
        authSets[authSet] = true;
    }

    if (!ok) {
        logger.debug('validateConfig - validation aborted (checks failed)');
        return false;
    }
    
    logger.debug('validateConfig - verifying devices');

    if (!adapter.config.devs.length) { 
        logger.error('no devices configured, please add configuration.');
        ok = false;
    };
    
    for (let ii=0; ii < adapter.config.devs.length; ii++) {
        let dev = adapter.config.devs[ii];
        
        if (!dev.devAct) continue;

        dev.devName         = dev.devName.trim();
        dev.devIpAddr       = dev.devIpAddr.trim();
        dev.devOidGroup     = dev.devOidGroup.trim();
        dev.devAuthId       = dev.devAuthId.trim();
        dev.devTimeout      = dev.devTimeout;
        dev.devRetryIntvl   = dev.devRetryIntvl;
        dev.devPollIntvl    = dev.devPollIntvl;

        if (/^\d+\.\d+\.\d+\.\d+(\:\d+)?$/.test(dev.devIpAddr)){
            /* might be ipv4 - to be checked further */
        } else {
            logger.error('ip address "'+dev.devIpAddr+'" has invalid format, please correct configuration.');
            ok = false;
        }

        if (!dev.devOidGroup || dev.devOidGroup == '' ) { 
            logger.error('device '+dev.devName+' ('+dev.devIpAddr+') does not specify a oid group. Please correct configuration.');
            ok = false;
        };

        if (dev.devOidGroup && dev.devOidGroup != '' && !oidSets[dev.devOidGroup] ) { 
            logger.error('device '+dev.devName+' ('+dev.devIpAddr+') references unknown oid group '+dev.devOidGroup+'. Please correct configuration.');
            ok = false;
        };

        if (dev.devSnmpVers == SNMP_V3 && dev.authId =='') { 
            logger.error('device '+dev.devName+' ('+dev.devIpAddr+') requires valid authorization id. Please correct configuration.');
            ok = false;
        };

        if (dev.devSnmpVers == SNMP_V3 && dev.devAuthId !='' && !oidSets[dev.devAuthId]) { 
            logger.error('device '+dev.devName+' ('+dev.devIpAddr+') references unknown authorization group '+dev.devAuthId+'. Please correct configuration.');
            ok = false;
        };
        
        if (!/^\d+$/.test(dev.devTimeout)){
            logger.error('device "'+dev.devName+'" - timeout ('+dev.devTimeout+') must be numeric, please correct configuration.');
            ok = false;
        };
        dev.devTimeout = parseInt(dev.devTimeout, 10) || 5;
        
        if (!/^\d+$/.test(dev.devRetryIntvl)){
            logger.error('device "'+dev.devName+'" - retry intervall ('+dev.devRetryIntvl+') must be numeric, please correct configuration.');
            ok = false;
        };
        dev.devRetryIntvl = parseInt(dev.devRetryIntvl, 10) || 5;

        if (!/^\d+$/.test(dev.devPollIntvl)){
            logger.error('device "'+dev.devName+'" - poll intervall ('+dev.devPollIntvl+') must be numeric, please correct configuration.');
            ok = false;
        };
        dev.devPollIntvl = parseInt(dev.devPollIntvl, 10) || 30;

        if (dev.devPollIntvl < 5 ) {
            logger.warn('device "'+dev.devName+'" - poll intervall ('+dev.devPollIntvl+') must be at least 5 seconds, please correct configuration.');
            dev.devPollIntvl = 5;
        }
    };

    if (!ok) {
        logger.debug('validateConfig - validation aborted (checks failed)');
        return false;
    }    
    
	logger.debug('validateConfig - validation completed (checks passed)');
	return true;
}

/**
 * setupContices - setup contices for worker threads
 *
 * @param
 * @return
 *
 *	CTX		object containing data for one device 
 *			it has the following attributes
 *		ip			string 	ip address of target device
 *		ipStr		string	ip address of target device with invalid chars removed
 *		OIDs		array of OID objects 
 *		oids		array of oid strings (used for snmp call)
 *		ids			array of id strings (index syncet o oids array)
 * 		authId 	    string 	snmp community (snmp V1, V2 only) 
 *		initialized	boolean	true if connection is initialized 
 *		inactive	boolean	true if connection to device is active
 */
function setupContices() {
	logger.debug('setupContices - initializing contices');

    for (let ii=0, jj=0; ii < adapter.config.devs.length; ii++) {
        let dev = adapter.config.devs[ii];
        
        if (!dev.devAct){ 
            continue;
        };
        
        logger.debug('adding device "'+dev.devIpAddr+'" ('+dev.devName+')');

        // TODO: ipV6 support
        const tmp    = dev.devIpAddr.split(':');
        const ipAddr = tmp[0];
        const ipPort = tmp[1] || 161;

        CTXs[jj]            = {};
        CTXs[jj].name       = dev.devName;
        CTXs[jj].ipAddr     = ipAddr;
        CTXs[jj].ipPort     = ipPort;
        CTXs[jj].id         = adapter.config.optUseName ? dev.devName : ip2ipStr(CTXs[jj].ipAddr); //TODO: IPv6 requires changes
        CTXs[jj].isIPv6     = false;
        CTXs[jj].timeout    = dev.devTimeout*1000;      //s -> ms
        CTXs[jj].retryIntvl = dev.devRetryIntvl*1000;    //s -> ms
        CTXs[jj].pollIntvl  = dev.devPollIntvl*1000;     //s -> ms
        CTXs[jj].snmpVers   = dev.devSnmpVers;
        CTXs[jj].authId     = dev.devAuthId;
        CTXs[jj].oids       = [];
        CTXs[jj].ids        = [];

        CTXs[jj].pollTimer  = null;     // poll intervall timer
        CTXs[jj].session    = null;     // snmp session
        CTXs[jj].inactive   = true;     // connection status of device
        
        for (let oo=0; oo < adapter.config.oids.length; oo++) {
            let oid = adapter.config.oids[oo];

            // skip inactive oids and oids belonging to other oid groups
            if (!oid.oidAct) continue;
            if (dev.devOidGroup != oid.oidGroup) continue;
            
            let id = CTXs[ii].id + '.' + name2id(oid.oidName);
            CTXs[jj].oids.push(oid.oidOid);
            CTXs[jj].ids.push(id);
            
            logger.debug('       oid "'+oid.oidOid+'" ('+id+')');
        }
        
        jj++;
    }
}

// #################### adapter main functions ####################

/**
 * onReady - will be called as soon as adapter is ready
 *
 * @param
 * @return
 *
 */
async function onReady() {

	await logger.debug("onReady triggered");

    if (doInstall) {
        const instUtils =  new mcmInstUtils(adapter, logger);

        await logger.info("performing installation");        
        await instUtils.doUpgrade();
        await logger.info("installation completed");

        didInstall = true;
        process.exit(0);
    }

	// mark adapter as non active
	await adapter.setStateAsync('info.connection', false, true);

	// validate config
	if (!validateConfig(adapter.config)) {
		await logger.error('invalid config, cannot continue');
		adapter.disable();
		return;
	}

	
    // setup worker thread contices
    setupContices();
    
    // init all objects
    await initAllObjects();
    
	await logger.debug('initialization completed');

	// start one reader thread per device
	await logger.debug('starting reader threads');
    for (let ii=0; ii<CTXs.length; ii++) { 
		const CTX = CTXs[ii];
		createSession(CTX);
	}
	
	// start connection info updater
	await logger.debug('startconnection info updater');
    connUpdateTimer = setInterval(handleConnectionInfo, 15000)

	await logger.debug('startup completed');

}

/**
 * onUnload - called when adapter shuts down
 *
 * @param {callback} callback 	callback function
 * @return
 *
 */
function onUnload(callback) {
	logger.debug("onUnload triggered");
    
//	for (let ip in IPs) {
//		if (IPs.hasOwnProperty(ip) && IPs[ip].session) {
//			try {
//				IPs[ip].session.close();
//				adapter.setState(ip.replace(/\./g, "_") + '.online', false, true);
//			} catch (e) {
//				// Ignore
//			}
//			IPs[ip].session = null;
//			IPs[ip].pollTimer && clearInterval(IPs[ip].pollTimer);
//			IPs[ip].retryTimeout && clearTimeout(IPs[ip].retryTimeout);
//		}
//	}

    try {
		if (connUpdateTimer) {
			clearInterval(connUpdateTimer);
			connUpdateTimer = null;
		}
    } catch(e) {
        // Ignore
    }

    try {
        adapter.setState('info.connection', false, true);
    } catch(e) {
        // Ignore
    }

	// callback must be called under all circumstances
    callback && callback();
}

/**
 * here we start
 */
console.log( "DEBUG  : snmp adapter initializing ("+process.argv+") ..."); //logger not yet initialized

if (process.argv) {
    for (let a = 1; a < process.argv.length; a++) {
        if (process.argv[a] === '--install') {
            doInstall = true;
            process.on('exit', function(){
                if (!didInstall) {
                    console.log("WARNING: migration of config skipped - ioBroker might be stopped");
                }
            })
        }
    }
}

if (require.main !== module) {
	// Export startAdapter in compact mode
	module.exports = startAdapter;
} else {
	// otherwise start the instance directly
	startAdapter();
}
