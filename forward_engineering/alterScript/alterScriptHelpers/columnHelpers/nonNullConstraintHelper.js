const { AlterScriptDto } = require('../../types/AlterScriptDto');

/**
 * @return {(collection: Object) => AlterScriptDto[]}
 * */
const getModifyNonNullColumnsScriptDtos = (_, ddlProvider) => collection => {
	const { getFullTableName, wrapInQuotes } = require('../../../utils/general')(_);
	const fullTableName = getFullTableName(collection);
	const isCollectionActivated = collection.role?.isActivated !== false;

	const currentRequiredColumnNames = collection.required || [];
	const previousRequiredColumnNames = collection.role.required || [];

	const columnNamesToAddNotNullConstraint = _.difference(currentRequiredColumnNames, previousRequiredColumnNames);
	const columnNamesToRemoveNotNullConstraint = _.difference(previousRequiredColumnNames, currentRequiredColumnNames);

	const addNotNullConstraintsScript = _.toPairs(collection.properties)
		.filter(([name, jsonSchema]) => {
			const oldName = jsonSchema.compMod.oldField.name;
			const shouldRemoveForOldName = columnNamesToRemoveNotNullConstraint.includes(oldName);
			const shouldAddForNewName = columnNamesToAddNotNullConstraint.includes(name);
			return shouldAddForNewName && !shouldRemoveForOldName;
		})
		.map(([columnName, jsonSchema]) => {
			const script = ddlProvider.setNotNullConstraint(fullTableName, wrapInQuotes(columnName));
			const isActivated = isCollectionActivated && jsonSchema.isActivated !== false;
			return AlterScriptDto.getInstance([script], isActivated, false);
		});

	const removeNotNullConstraint = _.toPairs(collection.properties)
		.filter(([name, jsonSchema]) => {
			const oldName = jsonSchema.compMod.oldField.name;
			const shouldRemoveForOldName = columnNamesToRemoveNotNullConstraint.includes(oldName);
			const shouldAddForNewName = columnNamesToAddNotNullConstraint.includes(name);
			return shouldRemoveForOldName && !shouldAddForNewName;
		})
		.map(([name, jsonSchema]) => {
			const script = ddlProvider.dropNotNullConstraint(fullTableName, wrapInQuotes(name));
			const isActivated = isCollectionActivated && jsonSchema.isActivated !== false;
			return AlterScriptDto.getInstance([script], isActivated, true);
		});

	return [...addNotNullConstraintsScript, ...removeNotNullConstraint];
};

module.exports = {
	getModifyNonNullColumnsScriptDtos,
};
