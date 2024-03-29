module.exports = ({ _, getColumnsList, checkAllKeysDeactivated }) => {
	const getTableTemporaryValue = (temporary, unlogged) => {
		if (temporary) {
			return ' TEMPORARY';
		}

		if (unlogged) {
			return ' UNLOGGED';
		}

		return '';
	};

	const getTableOptions = tableData => {
		const wrap = value => (value ? `${value}\n` : '');

		const statements = [
			{ key: 'inherits', getValue: getBasicValue('INHERITS') },
			{ key: 'partitionBounds', getValue: getBasicValue('') },
			{ key: 'partitioning', getValue: getPartitioning },
			{ key: 'usingMethod', getValue: getBasicValue('USING') },
			{ key: 'storage_parameter', getValue: getStorageParameters },
			{ key: 'on_commit', getValue: getOnCommit },
			{ key: 'selectStatement', getValue: getBasicValue('AS') },
		]
			.map(config => wrap(config.getValue(tableData[config.key], tableData)))
			.filter(Boolean)
			.join('');

		return _.trim(statements) ? ` ${_.trim(statements)}` : '';
	};

	const getPartitioning = (value, { isActivated }) => {
		if (value && value.partitionMethod) {
			const partitionKeys = getPartitionKeys(value, isActivated);
			const expression = partitionKeys + ` (${value.partitioning_expression})`;

			return `PARTITION BY ${value.partitionMethod}${expression}`;
		}
	};

	const getPartitionKeys = (value, isParentActivated) => {
		const isAllColumnsDeactivated = checkAllKeysDeactivated(value.compositePartitionKey);

		return getColumnsList(value.compositePartitionKey, isAllColumnsDeactivated, isParentActivated);
	};

	const getOnCommit = (value, table) => {
		if (value && table.temporary) {
			return `ON COMMIT ${value}`;
		}
	};

	const getBasicValue = prefix => value => {
		if (value) {
			return `${prefix} ${value}`;
		}
	};

	const getStorageParameters = value => {
		if (_.isEmpty(value)) {
			return '';
		}

		const nestedProperties = ['ttl_storage_parameters'];
		const keysToSkip = ['id', ...nestedProperties];

		return _.chain(value)
			.toPairs()
			.flatMap(([key, value]) => {
				if (nestedProperties.includes(key)) {
					return _.toPairs(value);
				}

				return [[key, value]];
			})
			.reject(([key]) => _.includes(keysToSkip, key))
			.map(([key, value]) => {
				if (!value && value !== 0) {
					return;
				}

				return `${key}=${value}`;
			})
			.compact()
			.join(',\n\t')
			.trim()
			.thru(storageParameters => {
				if (storageParameters) {
					return `WITH (\n\t${storageParameters}\n)`;
				}
			})
			.value();
	};

	return {
		getTableTemporaryValue,
		getTableOptions,
	};
};
