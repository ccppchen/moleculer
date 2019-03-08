"use strict";

const _ 					= require("lodash");
const Promise 				= require("bluebird");
const fetch 				= require("node-fetch");
//const { MoleculerError } 	= require("../../errors");
const BaseTraceExporter 	= require("./base");

const Jaeger 						= require("jaeger-client");
const GuaranteedThroughputSampler 	= require("jaeger-client/dist/src/samplers/guaranteed_throughput_sampler").default;
const RemoteControlledSampler 		= require("jaeger-client/dist/src/samplers/remote_sampler").default;
const UDPSender 					= require("jaeger-client/dist/src/reporters/udp_sender").default;

fetch.Promise = Promise;

/**
 * Trace Exporter for Jaeger.
 *
 * http://jaeger.readthedocs.io/en/latest/getting_started/#all-in-one-docker-image
 *
 * Running Jaeger in Docker:
 *
 * 		docker run -d --name jaeger -p5775:5775/udp -p6831:6831/udp -p6832:6832/udp -p5778:5778 -p16686:16686 -p14268:14268 jaegertracing/all-in-one:latest
 *
 * UI: http://<docker-ip>:16686/
 *
 * @class JaegerTraceExporter
 */
class JaegerTraceExporter extends BaseTraceExporter {

	/**
	 * Creates an instance of JaegerTraceExporter.
	 * @param {Object?} opts
	 * @memberof JaegerTraceExporter
	 */
	constructor(opts) {
		super(opts);

		this.opts = _.defaultsDeep(this.opts, {

			/** @type {String} UDP Sender host option. */
			host: "127.0.0.1",
			/** @type {Number?} UDP Sender port option. */
			port: 6832,

			/** @type {Object?} Sampler configuration. */
			sampler: {
				/** @type {String?} Sampler type */
				type: "Const",

				/** @type: {Object?} Sampler specific options. */
				options: {}
			},

			/** @type {Object?} Additional options for `Jaeger.Tracer` */
			tracerOptions: {},

			/** @type {Object?} Default span tags */
			defaultTags: null
		});

		this.tracers = {};
	}

	/**
	 * Initialize Trace Exporter.
	 *
	 * @param {Tracer} tracer
	 * @memberof JaegerTraceExporter
	 */
	init(tracer) {
		super.init(tracer);

		this.defaultTags = _.isFunction(this.opts.defaultTags) ? this.opts.defaultTags.call(this, tracer) : this.opts.defaultTags;
		if (this.defaultTags) {
			this.defaultTags = this.flattenTags(this.defaultTags);
		}
	}

	/**
	 * Get reporter instance for Tracer
	 *
	 */
	getReporter() {
		return new Jaeger.RemoteReporter(new UDPSender({ host: this.opts.host, port: this.opts.port }));
	}

	/**
	 * Get sampler instance for Tracer
	 *
	 */
	getSampler(serviceName) {
		if (_.isFunction(this.opts.sampler))
			return this.opts.sampler;

		if (this.opts.sampler.type == "RateLimiting")
			return new Jaeger.RateLimitingSampler(this.opts.sampler.options.maxTracesPerSecond, this.opts.sampler.options.initBalance);

		if (this.opts.sampler.type == "Probabilistic")
			return new Jaeger.ProbabilisticSampler(this.opts.sampler.options.samplingRate);

		if (this.opts.sampler.type == "GuaranteedThroughput")
			return new GuaranteedThroughputSampler(this.opts.sampler.options.lowerBound, this.opts.sampler.options.samplingRate);

		if (this.opts.sampler.type == "RemoteControlled")
			return new RemoteControlledSampler(serviceName, this.opts.sampler.options);

		return new Jaeger.ConstSampler(this.opts.sampler.options && this.opts.sampler.options.decision != null ? this.opts.sampler.options.decision : 1);
	}

	/**
	 * Get a tracer instance by service name
	 *
	 * @param {any} serviceName
	 * @returns {Jaeger.Tracer}
	 */
	getTracer(serviceName) {
		if (this.tracers[serviceName])
			return this.tracers[serviceName];

		const sampler = this.getSampler();
		const reporter = this.getReporter();

		const tracer = new Jaeger.Tracer(serviceName, reporter, sampler, this.opts.tracerOptions);
		this.tracers[serviceName] = tracer;

		return tracer;
	}

	/**
	 * Span is finished.
	 *
	 * @param {Span} span
	 * @memberof JaegerTraceExporter
	 */
	finishSpan(span) {
		this.generateJaegerSpan(span);
	}

	/**
	 * Create Jaeger tracing span
	 *
	 * @param {Span} span
	 * @returns {Object}
	 */
	generateJaegerSpan(span) {
		const serviceName = span.service ? span.service.name : null;
		const tracer = this.getTracer(serviceName);

		let parentCtx;
		if (span.parentID) {
			parentCtx = new Jaeger.SpanContext(
				this.convertID(span.traceID), // traceId,
				this.convertID(span.parentID), // spanId,
				null, // parentId,
				null, // traceIdStr
				null, // spanIdStr
				null, // parentIdStr
				1, // flags
				{}, // baggage
				"" // debugId
			);
		}

		const jaegerSpan = tracer.startSpan(span.name, {
			startTime: span.startTime,
			childOf: parentCtx,
			tags: this.flattenTags(_.defaultsDeep({
				service: span.service
			}, span.tags, this.defaultTags))
		});

		this.addTags(jaegerSpan, "service", serviceName);
		this.addTags(jaegerSpan, Jaeger.opentracing.Tags.SPAN_KIND, Jaeger.opentracing.Tags.SPAN_KIND_RPC_SERVER);

		const sc = jaegerSpan.context();
		sc.traceId = this.convertID(span.traceID);
		sc.spanId = this.convertID(span.id);

		if (span.error) {
			this.addTags(jaegerSpan, Jaeger.opentracing.Tags.ERROR, true);
			this.addTags(jaegerSpan, "error.name", span.error.name);
			this.addTags(jaegerSpan, "error.message", span.error.message);
			this.addTags(jaegerSpan, "error.type", span.error.type);
			this.addTags(jaegerSpan, "error.code", span.error.code);

			if (span.error.data)
				this.addTags(jaegerSpan, "error.data", span.error.data);

			if (span.error.stack)
				this.addTags(jaegerSpan, "error.stack", span.error.stack.toString());
		}

		jaegerSpan.finish(span.endTime);

		return jaegerSpan;
	}

	/**
	 * Add tags to span
	 *
	 * @param {Object} span
	 * @param {String} key
	 * @param {any} value
	 * @param {String?} prefix
	 */
	addTags(span, key, value, prefix) {
		const name = prefix ? `${prefix}.${key}` : key;
		if (typeof value == "object") {
			Object.keys(value).forEach(k => this.addTags(span, k, value[k], name));
		} else {
			span.setTag(name, value);
		}
	}

	/**
	 * Convert Trace/Span ID to Jaeger format
	 *
	 * @param {String} id
	 * @returns {String}
	 */
	convertID(id) {
		if (id) {
			return Buffer.from(id.replace(/-/g, "").substring(0, 16), "hex");
			//return new Int64(id.replace(/-/g, "").substring(0, 16)).toBuffer();
		}
		return null;
	}

}

module.exports = JaegerTraceExporter;
