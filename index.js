const async = require('async');
const SystemHelper = require('../../helpers/SystemHelper');

class MainController {

  /**
   * @param {ApiService} apiService
   * @param {OperationsService} operationsService
   * @param {CollaborationService} collaborationService
   * @param {SystemService} systemService
   * @param {Object} config
   * @param {Object} constantsEvents
   * @param {LogSystem} logSystem
   * @param {Metrics} metrics
   * @param {CoreUtils} coreUtils
   * @param {WatcherService} watcherService
   * @param {OperationsFactory} operationsFactory
   * @param {Memory} memory
   * @param {Object} operationsConstants
   * @param {Phase} phase
   * @param {WebhookModel} webhookModel
   */
  constructor({
    apiService, operationsService, collaborationService, systemService, config, logSystem,
    constantsEvents, activityHistoryConstants, messaging, metrics, coreUtils,
    watcherService, operationsFactory, memory, operationsConstants, phase, webhookModel,
  }) {
    this.apiService = apiService;
    this.operationsService = operationsService;
    this.collaborationService = collaborationService;
    this.config = config;
    this.messaging = messaging;
    this.logSystem = logSystem;
    this.constantsEvents = constantsEvents;
    this.channel = activityHistoryConstants.channel;
    this.metrics = metrics;
    this.utils = coreUtils;
    this.watcherService = watcherService;
    this.operationsFactory = operationsFactory;
    this.memory = memory;
    this.operationsConstants = operationsConstants;
    this.systemService = systemService;
    this.phase = phase;
    this.webhookModel = webhookModel;
    this.systemHelper = new SystemHelper();
  }

// ------------------------
// CLIENT MESSAGES HANDLERS
// ------------------------

  /**
   *
   * @param uid
   * @param auth
   * @param reconnect
   * @param clientStatus
   * @param timestamp
   * @param callback
   * @returns {*}
   */
  auth({ uid, auth, reconnect, clientStatus, timestamp }, callback) {
    const { systemHelper, logSystem, constantsEvents, channel } = this;
    const messageAge = systemHelper.isOldMessage(timestamp);

    if (messageAge) {
      logSystem.error(constantsEvents.SYSTEM_ERROR, {
        uid,
        error: `Old auth message from WebSocketConnectionService. Age: ${messageAge} ms`,
        message: { uid, auth, reconnect, clientStatus, timestamp },
        channel: channel.SERVER,
      });

      return callback();
    }

    const { apiService, collaborationService, config } = this;
    const { sessionHash, clientType } = auth.properties;
    const point = constantsEvents.AUTH_INPUT;
    const responseHandler = collaborationService.authResponseHandler(
      { uid, clientStatus, clientType },
      callback
    );

    logSystem.activity(
      point,
      { uid, auth, channel: channel.CLIENT, phase: this.phase.create({ point }) }
    );

    if (reconnect) {
      return apiService.reconnectClient(
        uid,
        auth.properties,
        responseHandler,
      );
    }

    async.waterfall([
      next => apiService.authClient(uid, auth.properties, next),
      /**
       * @param {Object} res.auth contains auth package
       * @param {Array} res.operations contains initalOps
       */
      (res, next) => collaborationService.setIds(
        uid,
        config.clientId,
        res.operations,
        (err, operations) => next(err, Object.assign(res, { operations }))
      ),
      (res, next) => collaborationService.saveOperations(
        uid,
        Object.assign(res, { initial: true }),
        (err, operations) =>
          next(err, Object.assign(res, { operations, sessionHash }))
      ),
    ], responseHandler);
  }

  operations({ operations, uid, clientStatus, timestamp }, callback) {
    const { systemHelper, logSystem, constantsEvents, channel } = this;
    const messageAge = systemHelper.isOldMessage(timestamp);

    if (messageAge) {
      logSystem.error(constantsEvents.SYSTEM_ERROR, {
        uid,
        error: `Old operations message from WebSocketConnectionService. Age: ${messageAge} ms`,
        message: { operations, uid, clientStatus, timestamp },
        channel: channel.SERVER,
      });

      return callback();
    }

    const { operationsService, collaborationService, config } = this;
    const responseHandler = collaborationService.defaultResponseHandler(
      { uid, clientStatus },
      callback
    );

    operations = operationsService.logOperations(
      uid,
      operations,
      channel.CLIENT
    );

    const authProps = operationsService.getAuthRequestProps(operations);

    if (!operations.length) {
      return responseHandler();
    }

    if (authProps) {
      return collaborationService.handleAuthRequest(uid, authProps, clientStatus, responseHandler);
    }

    /** @param {Object} res contains operations array
     * and may contain auth/destroy objects */
    async.waterfall([
      next => operationsService.processOperations(uid, operations, next),
      (res, next) => collaborationService.setIds(
        uid,
        config.clientId,
        res.operations,
        (err, ops) => next(err, Object.assign(res, { ops }))
      ),
      (res, next) => collaborationService.saveOperations(
        uid,
        { operations: res.operations },
        (err, indexedOperations) =>
          next(err, { auth: res.auth, operations: indexedOperations })
      ),
    ], responseHandler);
  }

  destroy({ uid, params = {}, sessionHash, clientStatus, timestamp }, callback = () => {}) {
    const { systemHelper, logSystem, constantsEvents, channel } = this;
    const messageAge = systemHelper.isOldMessage(timestamp);

    if (messageAge) {
      logSystem.error(constantsEvents.SYSTEM_ERROR, {
        uid,
        error: `Old destroy message from WebSocketConnectionService. Age: ${messageAge} ms`,
        message: { uid, params, sessionHash, clientStatus, timestamp },
        channel: channel.SERVER,
      });

      return callback();
    }

    const { apiService, collaborationService } = this;
    const { DESTROY_INPUT } = constantsEvents;
    const responseHandler = collaborationService.destroyResponseHandler(
      { uid, clientStatus, sessionHash },
      callback
    );

    const phase = this.phase.create({ point: DESTROY_INPUT });

    logSystem.activity(
      DESTROY_INPUT,
      { uid, params, phase, sessionHash, channel: channel.CLIENT },
    );

    apiService.disconnectClient(
      uid,
      { destroyParams: Object.assign({ sessionHash }, params) },
      responseHandler,
    );
  }

// -----------------------
// SYSTEM EVENTS
// -----------------------

  newProject({ projectId }) {
    const { logSystem, constantsEvents } = this;

    logSystem.info(constantsEvents.MESSAGING_NEW_PROJECT, { projectId });
  }

  projectClose({ projectId }) {
    const { logSystem, constantsEvents } = this;

    logSystem.info(constantsEvents.MESSAGING_PROJECT_CLOSE, { projectId });
  }

  system({ system }, callback) {
    const {
      config, logSystem, constantsEvents, watcherService, systemService, collaborationService,
    } = this;
    const { removeQueue, projectWatcher, hookId, hookData } = system;

    logSystem.info(constantsEvents.SYSTEM_MESSAGE, system);

    if (removeQueue) return systemService.removeQueue(removeQueue, callback);
    if (projectWatcher) {
      const { disconnectTimeout } = config.ManagerService.projectsWatcher;

      watcherService.idleProjectsChecker(disconnectTimeout, (projectId =>
        collaborationService.sendQueueCloseMessage(projectId)))();
      return callback();
    }
    if (hookId) {
      systemService.runWebhook(hookId, hookData);
      return callback();
    }
    /*
    * call callback for all unhandled cases
    */
    callback();
  }

  onRabbitMessage() {
    this.logSystem.onRabbitMessage();
  }

// -----------------------
// INTERVAL JOBS
// -----------------------

  startIntervalJobs(isReconnect) {
    const { metrics, messaging, watcherService, collaborationService } = this;

    if (isReconnect) return;

    watcherService.watchIdleClients(uid =>
      collaborationService.postDestroyMessage(uid));
    watcherService.watchIdleProjects(projectId =>
      collaborationService.sendQueueCloseMessage(projectId));

    this.metrics.startInterval(() =>
      messaging.getProjects().length, metrics.keys.MANAGER_PROJECTS);
  }

// ----------------------
// REST REQUESTS HANDLERS
// ----------------------

  // SIGNATURES
  signatures({ signatureDone, signatureOpen, userId }, callback) {
    if (signatureOpen) {
      const { operationsFactory, collaborationService } = this;
      const operation = operationsFactory.content(
        'pending',
        {},
        null,
        this.operationsConstants.GROUP.SIGNATURES
      );

      collaborationService.sendToAllUserClients(
        userId,
        { operations: [operation] },
        callback
      );
    }

    if (signatureDone) {
      const { operationsService, operationsFactory,
        collaborationService, logSystem, constantsEvents, utils } = this;
      // todo: change this

      async.waterfall([
        next => operationsService.signaturesXMLtoJSON(
          userId,
          `${userId}_1_1`,
          [signatureDone],
          null,
          next
        ),
        (sigJSONList, next) => {
          const operation = operationsFactory.create(
            'signatures',
            'add',
            'curve',
            sigJSONList[0]
          );

          collaborationService.sendToAllUserClients(
            userId,
            { operations: [operation] },
            next
          );
        },
      ], (err, res) => {
        if (err) {
          logSystem.error(
            constantsEvents.SCRIPT_EXCEPTION,
            { error: utils.stringifyError(err) }
          );
        }
        callback(err, res);
      });
    }
  }

  // REST_DOCUMENT_CONTENT_REQUEST => REST_DOCUMENT_CONTENT_RESPONSE
  getDocumentContent(payload, callback) {
    this.apiService.makeDocumentContent(payload, callback);
  }
}

module.exports = MainController;
