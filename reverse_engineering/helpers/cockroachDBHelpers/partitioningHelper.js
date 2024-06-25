/**
 * @return {(
 *     partitionResult: Array<Object>
 * ) => (Array<{
 *     partitionMethod: string,
 *     compositePartitionKey: Array<string>,
 *     partitioning_expression: string,
 * }> | null)}
 * */
const preparePartition = _ => partitionResult => {
	if (!partitionResult) {
		return null;
	}

	const partitionMethod = getPartitionMethod(partitionResult);
	const compositePartitionKey = getCompositePartitionKey(_)(partitionResult);
	const partitioning_expression = getPartitionExpression(partitionResult);

	return [
		{
			partitionMethod,
			compositePartitionKey,
			partitioning_expression,
		},
	];
};

/**
 * @return {string}
 */
const getPartitionMethodByRow = (row = {}) => {
	if (row.list_value) {
		return 'LIST';
	}
	if (row.range_value) {
		return 'RANGE';
	}
	return '';
};

/**
 * @param partitionResult {Array<Object>}
 * @return {Array<Object>}
 * */
const getParentPartitionRows = (partitionResult = []) => {
	return partitionResult.filter(row => !row.parent_name);
};

/**
 * @param partitionResult {Array<Object>}
 * @param parentName {string | null}
 * @return {Array<Object>}
 * */
const getChildPartitionRows = (partitionResult = [], parentName = null) => {
	return partitionResult.filter(row => row.parent_name === parentName);
};

/**
 * @return {string}
 */
const getPartitionMethod = (partitionResult = []) => {
	const parentPartitionRows = getParentPartitionRows(partitionResult);
	if (!parentPartitionRows.length) {
		return '';
	}
	const firstRow = parentPartitionRows[0];
	return getPartitionMethodByRow(firstRow);
};

/**
 * @return {(partitionResult: Array<Object>) => Array<string>}
 * */
const getCompositePartitionKey =
	_ =>
	(partitionResult = []) => {
		const parentPartitionRows = partitionResult.filter(row => !row.parent_name);
		const columnNames = parentPartitionRows.flatMap(row => {
			const columnNames = row.column_names || '';
			return columnNames.split(',').map(name => name.trim());
		});
		return _.uniq(columnNames);
	};

/**
 * @param partitionResult {Array<Object>}
 * @return {string}
 * */
const getPartitionExpression = partitionResult => {
	const parentPartitionRows = getParentPartitionRows(partitionResult);
	if (!parentPartitionRows.length) {
		return '';
	}
	const firstRow = parentPartitionRows[0];
	const partitionMethod = getPartitionMethodByRow(firstRow);
	const columnNames = firstRow.column_names || '';

	const parentPartitions = parentPartitionRows
		.map(row =>
			getSinglePartitionExpression({
				partition: row,
				paddingFactor: 1,
				partitionResult,
			}),
		)
		.join(',\n');
	return `PARTITION BY ${partitionMethod} (${columnNames}) (
${parentPartitions}
)`;
};

/**
 * @param partition {Object}
 * @param partitionResult {Array<Object>}
 * @param paddingFactor {number}
 * @return {string}
 * */
const getSinglePartitionExpression = ({ partition, partitionResult, paddingFactor }) => {
	const valuesClause = partition.list_value ? 'VALUES IN' : 'VALUES FROM';
	const value = partition.list_value || partition.range_value || '';
	const baseDdlPadding = '\t'.repeat(paddingFactor);
	const baseDdl = `${baseDdlPadding}PARTITION ${partition.partition_name} ${valuesClause} ${value}`;

	const children = getChildPartitionRows(partitionResult, partition.partition_name);
	if (children.length) {
		const childPartitions = children
			.map(child =>
				getSinglePartitionExpression({
					partition: child,
					partitionResult,
					paddingFactor: paddingFactor + 1,
				}),
			)
			.join(',\n');

		const firstChildRow = children[0];
		const partitionMethod = getPartitionMethodByRow(firstChildRow);
		const columnNames = firstChildRow.column_names || '';
		return (
			baseDdl +
			` PARTITION BY ${partitionMethod} (${columnNames}) (\n` +
			childPartitions +
			'\n' +
			baseDdlPadding +
			')'
		);
	}
	return baseDdl;
};

/**
 * @param item {string}
 * @return {Array<string>}
 * */
const splitByEqualitySymbol = item => (item ? item.split('=') : []);

module.exports = {
	preparePartition,
};
