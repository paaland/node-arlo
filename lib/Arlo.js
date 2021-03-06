"use strict";

const EventEmitter = require('events').EventEmitter;
const Extend = require('util')._extend;
const Request = require('request');
const debug = require('debug')('Arlo');

const Constants = require('./ArloConstants');
const ArloBaseStation = require('./ArloBaseStation');
const ArloCamera = require('./ArloCamera');

const HTTP_GET  = 'GET',
      HTTP_POST = 'POST';

class Arlo extends EventEmitter {
    constructor() {
        super();

        this.devices = {};
        this.headers = {
            'User-Agent': 'request'
        }
        this.pendingSnapshots = {};
    }

    getDevices(callback) {
        this._get(Constants.WEB.DEVICES, {}, function(error, response, body) {
            debug(body);
            if (!body || body.success !== true) {
                return;
            }

            for (let i = 0; i < body.data.length; i++) {
                let device = body.data[i];

                if (device.deviceType === Constants.TYPE_BASESTATION) {
                    this.devices[device.deviceId] = new ArloBaseStation(device, this);
                    this.devices[device.deviceId].subscribe();
                    this.emit(Constants.EVENT_FOUND, this.devices[device.deviceId]);
                }
            }

            for (let i = 0; i < body.data.length; i++) {
                let device = body.data[i];

                if (device.deviceType === Constants.TYPE_CAMERA) {
                    this.devices[device.deviceId] = new ArloCamera(device, this);
                    this.emit(Constants.EVENT_FOUND, this.devices[device.deviceId]);
                }
            }
        }.bind(this));
    }

    login(username, password) {
        this._post(
            Constants.WEB.LOGIN,
            {'email': username, 'password': password},
            {},
            function(error, response, body) {
                debug(body);
                this.token = body.data.token;
                this.headers = Extend({'Authorization': this.token}, this.headers);

                this.userId = body.data.userId;
                this.subscribe(function() {
                    this.getDevices();
                }.bind(this));
            }.bind(this)
        );
    }

    subscribe(callback) {
        let reCamera = /cameras\/(.+)$/;
        let reSubscription = /subscriptions\/(.+)$/;

        Request
            .get({url: Constants.WEB.SUBSCRIBE + '?token=' + this.token, method: HTTP_GET, json: false, jar: true, headers: Extend({'Accept': 'text/event-stream'}, this.headers)})
            .on('data', function(data) {
                let str, msg;
                
                if (callback !== undefined) {
                    callback();
                    callback = undefined;
                }

                try {
                    str = "{" + data.toString().replace(/^event: message\s*data/, '"event": "message", "data"') + "}";
                    msg = JSON.parse(str);
                    debug(msg);
                }
                catch(e) {
                    debug(str);
                    return;
                }

                data = msg.data;

                switch (data.resource) {
                    case Constants.RESOURCE_CAMERAS:
                        for (let i = 0; i < msg.data.properties.length; i++) {
                            let info = msg.data.properties[i];
                            let camera = this.devices[info.serialNumber];

                            if (camera === undefined) {
                                continue;
                            }

                            camera.emit(Constants.EVENT_UPDATE, info);
                        }

                        break;
                    case Constants.RESOURCE_MODES:
                        let baseStation = this.devices[msg.data.from];

                        if (baseStation) {
                            baseStation.emit(msg.data.properties.active);
                        }

                        break;
                    default:
                        if (reSubscription.test(msg.data.resource)) {
                            let device = this.devices[msg.data.from];
                            
                            if (device !== undefined) {
                                device.isSubscribed = true;
                            }
                        }
                        else if (reCamera.test(msg.data.resource)) {
                            let deviceId;

                            [, deviceId] = msg.data.resource.match(reCamera);

                            let camera = this.devices[deviceId];

                            if (!camera || msg.data.properties === undefined) {
                                return;
                            }

                            switch(data.action) {
                                case "fullFrameSnapshotAvailable":
                                    camera.emit('fullFrameSnapshotAvailable', data.properties.presignedFullFrameSnapshotUrl);
                                    break;
                                case "is":
                                    if (data.properties.activityState === 'fullFrameSnapshot') {
                                        let callback = this.pendingSnapshots[data.transId];
                                        delete this.pendingSnapshots[data.transId];

                                        if (callback) {
                                            callback(data.error, data);
                                        }
                                    }
                                    else {
                                        camera.emit(Constants.EVENT_UPDATE, data.properties);
                                    }
                            }
                        }
                }
            }.bind(this))
            .on('error', (err) => {
                debug(err)
            })
    }

    downloadSnapshot(url, callback) {
        var bufs = [];

        Request
            .get(url)
            .on('data', function(data) {
                bufs.push(data);
            })
            .on('end', function() {
                callback(Buffer.concat(bufs));
            });
    }
    
    getSnapshot(device, callback, label) {
        if (!label) {
            label = 'node-arlo';
        }

        let parent = this.devices[device.parentId];
        let transId = label + '-' + device.deviceId + '!snapshot-' + Date.now();

        let body = {
            [Constants.FROM]       : this.userId + "_web",
            [Constants.TO]         : parent.id,
            [Constants.ACTION]     : Constants.ACTION_SET,
            [Constants.RESOURCE]   : Constants.RESOURCE_CAMERAS + "/" + device.deviceId,
            [Constants.PUBLISH]    : true,
            [Constants.TRANS_ID]   : transId,
            [Constants.PROPERTIES] : {"activityState":"fullFrameSnapshot"}
        }

        this._post(
            Constants.WEB.SNAPSHOT,
            body,
            {[Constants.XCLOUD_ID]: parent.cloudId},
            function(error, response, data) {
                if (data && data.success === true) {
                    this.pendingSnapshots[transId] = callback;
                }
                else {
                    callback(null);
                }
            }.bind(this)
        );
    }

    getStream(device, callback, label) {
        if (!label) {
            label = 'node-arlo';
        }

        let parent = this.devices[device.parentId];
        let transId = label + '-' + device.deviceId + '!stream-' + Date.now();

        let body = {
            [Constants.FROM]       : this.userId + "_web",
            [Constants.TO]         : parent.id,
            [Constants.ACTION]     : Constants.ACTION_SET,
            [Constants.RESOURCE]   : Constants.RESOURCE_CAMERAS + "/" + device.deviceId,
            [Constants.PUBLISH]    : true,
            [Constants.TRANS_ID]   : transId,
            [Constants.PROPERTIES] : {"activityState":"startUserStream", "cameraId":device.deviceId}
        }

        this._post(Constants.WEB.STREAM, body, {[Constants.XCLOUD_ID]: parent.cloudId}, callback);
    }

    notify(device, body, callback) {
        if (typeof device === 'string') {
            device = this.devices[device];
        }

        body[Constants.FROM] = this.userId + "_web";
        body[Constants.TO]   = device.id;

        this._post(Constants.WEB.NOTIFY + device.id, body, {[Constants.XCLOUD_ID]: device.cloudId}, callback);
    }

    _get(url, headers, callback) {
        Request(
            {url: url, method: HTTP_GET, json: true, jar: true, headers: Extend(headers || {}, this.headers)},
            function (error, response, body) {
                debug(body);

                if (callback) {
                    callback(error, response, body);
                }
            }
        );
    }

    _post(url, body, headers, callback) {
        debug({url: url, method: HTTP_POST, body: body, json:true, jar: true, headers: Extend(headers || {}, this.headers)});
        Request(
            {url: url, method: HTTP_POST, body: body, json:true, jar: true, headers: Extend(headers || {}, this.headers)},
            function (error, response, body) {
                debug(body);

                if (callback) {
                    callback(error, response, body);
                }
            }
        );
    }
}

Arlo.ARMED    = Constants.MODE_ARMED;
Arlo.DISARMED = Constants.MODE_DISARMED;

module.exports = Arlo;
