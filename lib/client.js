'use strict';
// Queue handler
// =============
//
// TODO: describe dependencies
//
var Queue = require('bull'),
    EventEmitter = require('events').EventEmitter,
    redis = require('redis'),
    util = require('util'),
    S3ArtifactPersistanceHandler = require('./S3ArtifactPersistanceHandler'),
    Worker = require('./Worker');

// The main purpose of `Client` object is to process the build queue and
// report back to result queue and also to stream output to redis pub/sub channel
//
// It accepts `host` and `port` of redis server and logger which must be able to
// respond to `info`, `warn`, `log` and `error`
//
// `Client` uses Revealing Module Pattern for expose simple public interface.
//
var Client = function (host, port, log) {
    // Worker object
    var worker = new Worker({
        postProcess : function (resultData,done) {
            log.info("artifact HANDLED:",resultData);
            (new S3ArtifactPersistanceHandler(log)).handle(resultData,done);
        }
    });
    // Logger object
    var log = log || console;
    // Referring current instance as emitter
    var emitter = this;

    // Build queue contains job order items
    var buildQueue = Queue("build", port, host);
    // Result queue contains job results
    var resultQueue = Queue("result", port, host);

    // Instance of redis used for streaming of output from container during build execution
    var reportChannel = redis.createClient(port, host);

    // Instance of redis used for saving output to the redis list
    // (we can not use instance reportChannel because once we switch to subscriber mode we can't execute regular functions)
    var report = redis.createClient(port, host);

    // Generates key to be used as channel name
    var getKey = function (id) {
        return "report:build:" + id;
    };

    // Handles streaming of output from container during build execution
    // also it saves all lines within redis list
    //
    // Arguments:
    // - `data` __literal__
    //        {
    //            id : <build id>,
    //            data: <line of output>
    //        }
    // - `job` __bull.Job__ object
    //
    var reportHandler = function (data, job) {
        var channel = "channel_" + job.data._id;
        var b = new Buffer(data.data);
        emitter.emit("progress", data);
        report.rpush(getKey(job.data._id), b);
        reportChannel.publish(channel, JSON.stringify(data));
    };

    // Handles result of build execution
    //
    // Arguments:
    // - `result` __literal__
    //        {
    //            status : {
    //                StatusCode : <exit code>
    //            }
    //        }
    // - `complete` __function__ bull complete callback
    //
    var resultHandler = function (result, complete) {
        resultQueue.add(result);
        complete();
    };

    // Handles the build process once new job order is available
    //
    // Arguments:
    // - `job` __bull.Job__ object
    // - `complete` __function__ bull complete callback
    var buildHandler = function (job, complete) {
        log.info("job processing");
        job.data.started = new Date().getTime();
        console.log("DATA",job.data.container.secondary);
        worker.put(job.data, function (data) {
            job.data.output = [];
            reportHandler(data, job)
        }).on('complete', function (result,artifact_name) {
            job.data.status = result;
            if(artifact_name){
                job.data.artifact_name = artifact_name;
            }
            job.data.finished = new Date().getTime();
            emitter.emit('complete', result);
            log.info("job processed");
            resultHandler(job.data, complete);
        }).on('timeout', function(result){
            job.data.status = result;
            job.data.finished = new Date().getTime();
            emitter.emit('timeout', result);
            log.info("job processed timeout");
            resultHandler(job.data, complete);
        }).on('error', function(result){
            job.data.status = {
                StatusCode: 500
            };
            job.data.finished = new Date().getTime();
            emitter.emit('error', result);
            log.info("job processed timeout");
            resultHandler(job.data, complete);
        });
    };

    // Starting waiting for new job order
    // this call is blocking as it uses redis blocking `BRPOPLPUSH` command
    buildQueue.process(buildHandler);


    // Object literal that describes public interface of `Client`
    return {
        close: function () {
            buildQueue.close();
            resultQueue.close();
            reportChannel.end();
            report.end();
        },
        complete: function (callback) {
            emitter.on('complete', callback);
        },
        progress: function (callback) {
            emitter.on('progress', callback);
        }
    }
};

// Inheriting from EventEmitter
util.inherits(Client, EventEmitter);

module.exports = Client;