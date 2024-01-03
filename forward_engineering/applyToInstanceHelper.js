const cockroachDBService = require('../reverse_engineering/helpers/cockroachDBService');

const applyToInstance = async (connectionInfo, logger, app) => {
	try {
		cockroachDBService.setDependencies(app);
		await cockroachDBService.connect(connectionInfo, logger);
		await cockroachDBService.logVersion();
		await cockroachDBService.applyScript(removeCreateDbScript(connectionInfo.script));
	} catch (error) {
		logger.error(error);
		throw prepareError(error);
	}
};

const removeCreateDbScript = script => {
	const createDbScriptRegexp = /CREATE DATABASE[^;]*;/gi;

	return script.replace(createDbScriptRegexp, '');
};

const prepareError = error => {
	error = JSON.stringify(error, Object.getOwnPropertyNames(error));
	error = JSON.parse(error);
	return error;
};

module.exports = { applyToInstance };
