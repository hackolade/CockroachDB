const { AlterCollectionDto } = require('../../types/AlterCollectionDto');
const { AlterScriptDto } = require('../../types/AlterScriptDto');

/**
 * @typedef {{
 *     id: string,
 *     chkConstrName: string,
 *     constrExpression: string,
 * }} CheckConstraint
 *
 * @typedef {{
 *     old?: CheckConstraint,
 *     new?: CheckConstraint
 * }} CheckConstraintHistoryEntry
 * */

/**
 * @return {(collection: AlterCollectionDto) => Array<CheckConstraintHistoryEntry>}
 * */
const mapCheckConstraintNamesToChangeHistory = _ => collection => {
	const checkConstraintHistory = collection?.compMod?.chkConstr;
	if (!checkConstraintHistory) {
		return [];
	}
	const newConstraints = checkConstraintHistory.new || [];
	const oldConstraints = checkConstraintHistory.old || [];
	const constrNames = _.chain([...newConstraints, ...oldConstraints])
		.map(constr => constr.chkConstrName)
		.uniq()
		.value();

	return constrNames.map(chkConstrName => {
		return {
			old: _.find(oldConstraints, { chkConstrName }),
			new: _.find(newConstraints, { chkConstrName }),
		};
	});
};

/**
 * @return {(constraintHistory: Array<CheckConstraintHistoryEntry>, fullTableName: string, isActivated: boolean) => Array<AlterScriptDto>}
 * */
const getDropCheckConstraintScriptDtos = (_, ddlProvider) => (constraintHistory, fullTableName, isActivated) => {
	const { wrapInQuotes } = require('../../../utils/general')(_);

	return constraintHistory
		.filter(historyEntry => historyEntry.old && !historyEntry.new)
		.map(historyEntry => {
			const wrappedConstraintName = wrapInQuotes(historyEntry.old.chkConstrName);
			return ddlProvider.dropConstraint(fullTableName, wrappedConstraintName);
		})
		.map(script => AlterScriptDto.getInstance([script], isActivated, true));
};

/**
 * @return {(constraintHistory: Array<CheckConstraintHistoryEntry>, fullTableName: string, isActivated: boolean) => Array<AlterScriptDto>}
 * */
const getAddCheckConstraintScriptDtos = (_, ddlProvider) => (constraintHistory, fullTableName, isActivated) => {
	const { wrapInQuotes } = require('../../../utils/general')(_);

	return constraintHistory
		.filter(historyEntry => historyEntry.new && !historyEntry.old)
		.map(historyEntry => {
			const { chkConstrName, constrExpression } = historyEntry.new;
			return ddlProvider.addCheckConstraint(fullTableName, wrapInQuotes(chkConstrName), constrExpression);
		})
		.map(script => AlterScriptDto.getInstance([script], isActivated, false));
};

/**
 * @return {(constraintHistory: Array<CheckConstraintHistoryEntry>, fullTableName: string, isActivated: boolean) => Array<AlterScriptDto>}
 * */
const getUpdateCheckConstraintScriptDtos = (_, ddlProvider) => (constraintHistory, fullTableName, isActivated) => {
	const { wrapInQuotes } = require('../../../utils/general')(_);

	return constraintHistory
		.filter(historyEntry => {
			if (historyEntry.old && historyEntry.new) {
				const oldExpression = historyEntry.old.constrExpression;
				const newExpression = historyEntry.new.constrExpression;
				return oldExpression !== newExpression;
			}
			return false;
		})
		.map(historyEntry => {
			const { chkConstrName: oldConstrainName } = historyEntry.old;
			const dropConstraintScript = ddlProvider.dropConstraint(fullTableName, wrapInQuotes(oldConstrainName));

			const { chkConstrName: newConstrainName, constrExpression: newConstraintExpression } = historyEntry.new;
			const addConstraintScript = ddlProvider.addCheckConstraint(
				fullTableName,
				wrapInQuotes(newConstrainName),
				newConstraintExpression,
			);

			return [
				AlterScriptDto.getInstance([dropConstraintScript], isActivated, true),
				AlterScriptDto.getInstance([addConstraintScript], isActivated, false),
			];
		})
		.flat();
};

/**
 * @return {(collection: AlterCollectionDto) => Array<AlterScriptDto>}
 * */
const getModifyCheckConstraintScriptDtos = (_, ddlProvider) => collection => {
	const { getFullTableName } = require('../../../utils/general')(_);
	const fullTableName = getFullTableName(collection);
	const constraintHistory = mapCheckConstraintNamesToChangeHistory(_)(collection);
	const isActivated = collection.role?.isActivated !== false;

	const addCheckConstraintScripts = getAddCheckConstraintScriptDtos(_, ddlProvider)(
		constraintHistory,
		fullTableName,
		isActivated,
	);
	const dropCheckConstraintScripts = getDropCheckConstraintScriptDtos(_, ddlProvider)(
		constraintHistory,
		fullTableName,
		isActivated,
	);
	const updateCheckConstraintScripts = getUpdateCheckConstraintScriptDtos(_, ddlProvider)(
		constraintHistory,
		fullTableName,
		isActivated,
	);

	return [...addCheckConstraintScripts, ...dropCheckConstraintScripts, ...updateCheckConstraintScripts];
};

module.exports = {
	getModifyCheckConstraintScriptDtos,
};
